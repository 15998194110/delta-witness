"""Synthetic Core transport and private temporary SQLite; no network or wallet."""
import base64
import concurrent.futures
import hashlib
import json
import socket
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import Mock

class BlockedSocket(socket.socket):
    def __init__(self, *args, **kwargs):
        raise RuntimeError('network forbidden')
socket.socket = BlockedSocket

from delta_witness import DeltaWitness, DeltaError, SQLiteOrderStore

OID = '2dc6fc8a-bd23-42b4-8ccc-c42c27cef22f'
OP1 = '11111111-1111-4111-8111-111111111111'
OP2 = '22222222-2222-4222-8222-222222222222'


class Authorization(unittest.TestCase):
    def setUp(self):
        self.path = Path(tempfile.mkdtemp(prefix='delta-python-export-auth-'))/'orders.sqlite'
        self.store = SQLiteOrderStore(self.path)
        self.remote = None
        self.posts = []
        self.client = DeltaWitness(order_store=self.store, transport=self.transport, request_timeout=1)
        self.client.prepare_order('capture', {'url': 'https://example.com'}, order_id=OID)
        self.original = self.store.load(OID)
        self.lost_ack = False
        self.expired = False

    def envelope(self):
        return {'ok': True, 'order_id': OID, 'authorization': self.remote}

    def transport(self, method, url, *, headers, body, **kwargs):
        self.assertNotIn('payment-signature', headers)
        self.assertNotIn('x-payment', headers)
        self.assertEqual(headers['x-delta-recovery-token'], self.original['recovery_token'])
        self.assertTrue(url.endswith('/v1/orders/' + OID + '/export-authorization'))
        if self.expired:
            return 410, {}, b'{}'
        if method == 'POST':
            request = json.loads(body)
            private = self.store.load(OID)['export_authorization']
            self.assertEqual(private['phase'], 'attempted')
            self.assertEqual(private['token'], request['token'])
            self.assertNotEqual(private['token'], self.original['recovery_token'])
            self.posts.append(request)
            generation = self.remote['generation'] if self.remote else 0
            if request['expected_generation'] != generation:
                return 409, {}, b'{}'
            self.remote = {'operation_id': request['operation_id'], 'generation': generation + 1,
                'expires_at': '2026-11-03T00:00:00.000Z', 'scope': ['export'], 'state': 'active'}
            if self.lost_ack:
                self.lost_ack = False
                raise OSError('fixture response lost; private details must not escape')
            return 201, {}, json.dumps(self.envelope()).encode()
        self.assertEqual(method, 'GET')
        self.assertIsNone(body)
        return 200, {}, json.dumps(self.envelope()).encode()

    def prepare(self, operation=OP1):
        return self.client.prepare_export_authorization(OID, operation_id=operation)

    def test_private_operation_is_durable_before_one_update_and_no_payment_state_changes(self):
        prepared = self.prepare()
        private = self.store.load(OID)['export_authorization']
        self.assertEqual(prepared, {'order_id': OID, 'operation_id': OP1, 'state': 'prepared'})
        self.assertNotIn(private['token'], str(prepared))
        result = self.client.execute_export_authorization(OID)
        self.assertEqual(result['authorization']['generation'], 1)
        self.assertNotIn(private['token'], str(result))
        record = self.store.load(OID)
        for key in self.original:
            if key != 'revision':
                self.assertEqual(record[key], self.original[key])
        self.assertEqual(record['export_authorization']['phase'], 'confirmed')
        self.client.execute_export_authorization(OID)
        self.assertEqual(len(self.posts), 1)

    def test_lost_response_survives_restart_and_reads_original_operation_without_another_post(self):
        self.prepare()
        self.lost_ack = True
        with self.assertRaises(DeltaError) as error:
            self.client.execute_export_authorization(OID)
        self.assertEqual(error.exception.code, 'export_authorization_unconfirmed')
        self.assertNotIn('private details', str(error.exception))
        self.assertEqual(self.store.load(OID)['export_authorization']['phase'], 'attempted')
        self.client = DeltaWitness(order_store=SQLiteOrderStore(self.path), transport=self.transport)
        self.assertEqual(self.client.execute_export_authorization(OID)['authorization']['operation_id'], OP1)
        self.assertEqual(len(self.posts), 1)

    def test_pending_operation_cannot_be_overwritten_and_same_operation_cannot_change_ttl(self):
        self.prepare()
        with self.assertRaises(DeltaError):
            self.client.prepare_export_authorization(OID, operation_id=OP1, ttl_seconds=900)
        with self.assertRaises(DeltaError):
            self.prepare(OP2)
        self.assertEqual(self.store.load(OID)['export_authorization']['operation_id'], OP1)
        self.assertEqual(len(self.posts), 0)

    def test_expired_derived_authorization_can_be_explicitly_updated_using_original_identity(self):
        self.prepare()
        self.client.execute_export_authorization(OID)
        self.remote['state'] = 'expired'
        self.prepare(OP2)
        self.assertEqual(self.store.load(OID)['export_authorization']['expected_generation'], 1)
        self.assertEqual(self.client.execute_export_authorization(OID)['authorization']['generation'], 2)
        self.assertEqual(len(self.posts), 2)

    def test_generation_conflict_is_unknown_without_automatic_resubmission(self):
        self.prepare()
        self.remote = {'operation_id': OP2, 'generation': 1,
            'expires_at': '2026-11-03T00:00:00Z', 'scope': ['export'], 'state': 'active'}
        with self.assertRaises(DeltaError):
            self.client.execute_export_authorization(OID)
        with self.assertRaises(DeltaError):
            self.client.execute_export_authorization(OID)
        self.assertEqual(len(self.posts), 1)
        self.assertEqual(self.store.load(OID)['export_authorization']['phase'], 'attempted')

    def test_expired_original_identity_does_not_create_a_new_operation(self):
        self.expired = True
        with self.assertRaises(DeltaError):
            self.prepare()
        self.assertEqual(self.store.load(OID), self.original)
        self.assertEqual(len(self.posts), 0)

    def test_private_store_failure_prevents_update_request(self):
        self.prepare()
        self.store.compare_and_set = Mock(side_effect=OSError('fixture unavailable'))
        with self.assertRaises(DeltaError):
            self.client.execute_export_authorization(OID)
        self.assertEqual(len(self.posts), 0)

    def test_two_clients_do_not_overwrite_each_others_prepared_token(self):
        barrier = threading.Barrier(2)
        def transport(*args, **kwargs):
            barrier.wait(timeout=3)
            return self.transport(*args, **kwargs)
        def prepare(op):
            client = DeltaWitness(order_store=SQLiteOrderStore(self.path), transport=transport)
            try:
                return client.prepare_export_authorization(OID, operation_id=op)
            except DeltaError:
                return None
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(prepare, [OP1, OP2]))
        self.assertEqual(sum(result is not None for result in results), 1)
        self.assertIn(self.store.load(OID)['export_authorization']['operation_id'], [OP1, OP2])
        self.assertEqual(len(self.posts), 0)

    def test_derived_export_uses_only_confirmed_token_and_never_falls_back_to_original(self):
        self.prepare()
        with self.assertRaises(DeltaError):
            self.client.export_artifact(OID, 'html', use_export_authorization=True)
        self.client.execute_export_authorization(OID)
        token = self.store.load(OID)['export_authorization']['token']
        observed = []
        raw = b'<h1>fixture original artifact</h1>'
        def export(method, url, *, headers, body, **kwargs):
            observed.append(headers['x-delta-recovery-token'])
            self.assertEqual(headers['x-delta-recovery-token'], token)
            return 200, {'content-length': str(len(raw)), 'content-disposition': 'attachment;',
                'x-delta-content-sha256': 'sha256:' + hashlib.sha256(raw).hexdigest()}, raw
        self.client.transport = export
        self.assertEqual(self.client.export_artifact(OID, 'html', use_export_authorization=True)['bytes'], raw)
        self.client.transport = lambda *a, **k: (410, {}, b'{}')
        with self.assertRaises(DeltaError):
            self.client.export_artifact(OID, 'html', use_export_authorization=True)
        self.assertEqual(observed, [token])

    def test_reflected_secret_or_wrong_scope_cannot_confirm_an_update(self):
        self.prepare()
        private = self.store.load(OID)['export_authorization']
        for change in [{'scope': ['recover']}, {'token': private['token']}, {'operation_id': OP2}, {'generation': True}]:
            self.remote = {'operation_id': OP1, 'generation': 1,
                'expires_at': '2026-11-03T00:00:00Z', 'scope': ['export'], 'state': 'active', **change}
            with self.assertRaises(DeltaError):
                self.client.recover_export_authorization(OID)
        self.assertEqual(self.store.load(OID)['export_authorization']['phase'], 'prepared')


if __name__ == '__main__':
    unittest.main()
