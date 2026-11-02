"""Offline tests: socket blocked, fake transport, synthetic temporary SQLite only."""
import hashlib
import json
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import Mock

class BlockedSocket(socket.socket):
    def __init__(self, *a, **kw): raise RuntimeError('network forbidden')
socket.socket = BlockedSocket
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from delta_witness import DeltaWitness, DeltaError, SQLiteOrderStore

ID = '2dc6fc8a-bd23-42b4-8ccc-c42c27cef22f'
PROOF = '56347db8-1aa5-447f-a0e4-3bb052d7aa89'
ORIGIN = 'https://delta-witness-api.ruphussten.workers.dev'


def response(body, status=200, headers=None):
    return status, headers or {}, json.dumps(body).encode()


def delivery(product='capture'):
    value = dict(ok=True, product=product, proof_id=PROOF, bundle_root='sha256:'+'a'*64,
        observed_at='2026-11-02T00:00:00Z', manifest_url=ORIGIN+'/v1/proofs/'+PROOF, public_proof_url=ORIGIN+'/p/'+PROOF)
    if product == 'preflight':
        value.update(safe=False, changed=True)
    return value


def envelope(product='capture'):
    return dict(ok=True, order_id=ID, product=product, state='complete',
        payment=dict(state='settlement_confirmed', treasury_received=None), fulfillment=dict(state='complete'),
        recovery=dict(can_recover=False, expires_at='2026-11-03T00:00:00Z'), delivery=delivery(product))


class Orders(unittest.TestCase):
    def setUp(self):
        self.directory = Path(tempfile.mkdtemp(prefix='delta-python-offline-'))
        self.path = self.directory/'orders.sqlite'
        self.store = SQLiteOrderStore(self.path)
        self.read = Mock(return_value=response(envelope()))
        self.client = DeltaWitness(order_store=self.store, transport=self.read)

    def prepare(self, product='capture', **kw):
        return self.client.prepare_order(product, {'url':'https://example.com'}, order_id=ID, **kw)

    def test_prepare_free_private(self):
        result = self.prepare()
        self.assertEqual(result, dict(order_id=ID, product='capture', state='prepared'))
        self.read.assert_not_called()
        self.assertNotIn(self.store.load(ID)['recovery_token'], str(result))

    def test_same_identity_changed_request_rejected(self):
        self.prepare()
        with self.assertRaises(DeltaError) as ctx:
            self.client.prepare_order('capture', {'url':'https://different.example'}, order_id=ID)
        self.assertEqual(ctx.exception.code, 'order_identity_conflict')

    def test_original_paid_once_then_restart_recovery(self):
        self.prepare()
        paid = Mock(side_effect=OSError('fixture private transport error'))
        with self.assertRaises(DeltaError): self.client.execute_order(ID, paid)
        restarted = DeltaWitness(order_store=SQLiteOrderStore(self.path), transport=self.read)
        self.assertEqual(restarted.execute_order(ID, paid)['delivery'], delivery())
        self.assertEqual(paid.call_count, 1)
        self.assertEqual(self.read.call_args.args[0], 'GET')
        self.assertNotIn('fixture private transport error', str(self.store.load(ID)))

    def test_negative_preflight_is_completed(self):
        self.prepare('preflight')
        paid = Mock(return_value=response(delivery('preflight')))
        result = self.client.execute_order(ID, paid)
        self.assertIs(result['delivery']['safe'], False)
        self.assertEqual(result['state'], 'complete')

    def test_repeated_completed_recovery_does_not_rewrite(self):
        self.prepare()
        self.client.execute_order(ID, Mock(return_value=response(delivery())))
        original = self.store.load(ID)
        cas = self.store.compare_and_set = Mock(wraps=self.store.compare_and_set)
        for _ in range(4):
            self.assertEqual(self.client.recover_order(ID)['state'], 'complete')
        self.assertEqual(self.read.call_count, 4)
        cas.assert_not_called()
        self.assertEqual(self.store.load(ID), original)

    def test_missing_is_not_unpaid(self):
        self.prepare()
        self.read.return_value = response({}, 404)
        for _ in range(2):
            with self.assertRaises(DeltaError): self.client.recover_order(ID)
        paid = Mock()
        with self.assertRaises(DeltaError): self.client.execute_order(ID, paid)
        paid.assert_not_called()

    def test_changed_origin_cannot_send_capability(self):
        self.prepare()
        client = DeltaWitness('https://other.example', order_store=self.store, transport=self.read)
        with self.assertRaises(DeltaError): client.recover_order(ID)
        self.read.assert_not_called()

    def test_policy_hash_persisted_before_one_payment(self):
        self.prepare(retention_policy_hash='sha256:'+'b'*64)
        paid = Mock(return_value=response(delivery()))
        self.client.execute_order(ID, paid)
        self.assertEqual(paid.call_args.kwargs['headers']['x-delta-retention-policy-hash'], 'sha256:'+'b'*64)

    def test_body_limit_and_unknown_response_do_not_retry(self):
        self.prepare()
        paid = Mock(return_value=(200, {}, b'x'*1048577))
        with self.assertRaises(DeltaError): self.client.execute_order(ID, paid)
        self.client.execute_order(ID, paid)
        self.assertEqual(paid.call_count, 1)

    def test_deadline_disables_late_signing(self):
        self.prepare()
        release, done, signed = threading.Event(), threading.Event(), []
        def paid(*args, active, **kwargs):
            release.wait(2)
            if active(): signed.append(True)
            done.set()
            return response(delivery())
        self.client.request_timeout = 0.02
        with self.assertRaises(DeltaError): self.client.execute_order(ID, paid)
        release.set()
        self.assertTrue(done.wait(1))
        self.assertEqual(signed, [])

    def test_capability_reflection_is_not_returned(self):
        self.prepare()
        value = delivery()
        value['reason'] = self.store.load(ID)['recovery_token']
        with self.assertRaises(DeltaError) as ctx:
            self.client.execute_order(ID, Mock(return_value=response(value)))
        self.assertNotIn(value['reason'], str(ctx.exception))

    def test_invalid_delivery_uuid_and_optional_types_denied(self):
        self.prepare()
        for change in ({'proof_id':'00000000-0000-0000-0000-000000000000'}, {'reason':True}, {'idempotent_replay':'true'}):
            value = {**delivery(), **change}
            with self.assertRaises(ValueError): self.client._delivery(value, self.store.load(ID))

    def test_recovery_post_is_once_no_payment_transport(self):
        self.prepare()
        pending = envelope()
        pending.pop('delivery')
        pending.update(state='recovery_available', reconciliation_required=True)
        pending['fulfillment']['state'] = 'recovery_available'
        pending['recovery']['can_recover'] = True
        self.read.side_effect = [response(pending, 202), response(envelope())]
        self.assertEqual(self.client.recover_order(ID)['state'], 'complete')
        self.assertEqual([call.args[0] for call in self.read.call_args_list], ['GET','POST'])

    def test_export_hash_and_identity(self):
        self.prepare()
        raw = b'<p>synthetic</p>'
        filename = 'delta-'+PROOF+'-page.html'
        headers = {'content-length':str(len(raw)), 'x-delta-content-sha256':'sha256:'+hashlib.sha256(raw).hexdigest(),
            'content-disposition':'attachment; filename="'+filename+'"'}
        self.read.side_effect = [(200,headers,raw)]
        exported = self.client.export_artifact(ID,'html')
        self.assertEqual(exported['bytes'],raw)
        self.assertEqual(exported['filename'],'delta-'+ID+'-page.html')

    def test_export_tamper_denied(self):
        self.prepare()
        self.read.side_effect = [(200, {'x-delta-content-sha256':'sha256:'+'a'*64}, b'changed')]
        with self.assertRaises(DeltaError): self.client.export_artifact(ID,'html')

    def test_multiple_processes_claim_once_and_restart_can_read(self):
        self.prepare()
        code = ('import sys; from delta_witness import SQLiteOrderStore; s=SQLiteOrderStore(sys.argv[1]); '
            'r=s.load(sys.argv[2]); r.update(revision=1,phase="signing_started"); '
            'print(s.compare_and_set(sys.argv[2],0,r))')
        processes = [subprocess.Popen([sys.executable,'-c',code,str(self.path),ID], cwd=Path(__file__).resolve().parents[1], stdout=subprocess.PIPE) for _ in range(4)]
        outcomes = [p.communicate(timeout=10)[0].strip() for p in processes]
        self.assertEqual(outcomes.count(b'True'),1)
        self.assertEqual(SQLiteOrderStore(self.path).load(ID)['phase'],'signing_started')

    def test_actual_process_restart_executes_only_original_recovery(self):
        self.prepare()
        code = '''
import json, sys, socket
class BlockedSocket(socket.socket):
    def __init__(self,*a,**kw): raise RuntimeError('offline')
socket.socket=BlockedSocket
from delta_witness import DeltaWitness, SQLiteOrderStore, DeltaError
calls=[]
def paid(*a,**kw):
    calls.append('paid')
    raise OSError('synthetic lost response')
def read(*a,**kw):
    calls.append(a[0])
    return 200,{},sys.stdin.buffer.read()
client=DeltaWitness(order_store=SQLiteOrderStore(sys.argv[1]),transport=read)
try:
    outcome=client.execute_order(sys.argv[2],paid)['state']
except DeltaError as error:
    outcome=error.code
print(json.dumps({'calls':calls,'outcome':outcome}))
'''
        args = [sys.executable,'-c',code,str(self.path),ID]
        first = subprocess.run(args,cwd=Path(__file__).resolve().parents[1],input=b'',capture_output=True,timeout=10,check=True)
        self.assertEqual(json.loads(first.stdout),{'calls':['paid'],'outcome':'payment_outcome_unconfirmed'})
        second = subprocess.run(args,cwd=Path(__file__).resolve().parents[1],input=json.dumps(envelope()).encode(),capture_output=True,timeout=10,check=True)
        self.assertEqual(json.loads(second.stdout),{'calls':['GET'],'outcome':'complete'})

    def test_free_quote_challenge_no_wallet_needed(self):
        self.read.return_value = response({'product':'capture','price':1})
        self.assertEqual(self.client.quote()['price'],1)
        self.read.return_value = response({'x402Version':2},402)
        self.assertEqual(self.client.payment_challenge('https://example.com')['status'],402)

    def test_actual_httpx_stream_transport(self):
        import httpx
        from unittest.mock import patch
        seen = []
        def handler(request):
            seen.append(request)
            return httpx.Response(200, json={'product':'capture','price':1})
        with httpx.Client(transport=httpx.MockTransport(handler)) as local:
            with patch('httpx.stream', side_effect=local.stream):
                client = DeltaWitness()
                self.assertEqual(client.quote()['price'],1)
        self.assertEqual(seen[0].headers['x-delta-channel'],'pypi')

    def test_actual_httpx_redirect_not_followed(self):
        import httpx
        from unittest.mock import patch
        handler = Mock(return_value=httpx.Response(302, headers={'location':'https://other.example'}))
        with httpx.Client(transport=httpx.MockTransport(handler)) as local:
            with patch('httpx.stream', side_effect=local.stream):
                with self.assertRaises(DeltaError): DeltaWitness().quote()
        self.assertEqual(handler.call_count,1)


if __name__ == '__main__': unittest.main()
