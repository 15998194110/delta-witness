"""Thin Core client; buyer supplies payment transport and spend policy.

Transport: (method, url, *, headers, body, timeout, active) returns
(HTTP status, headers, bytes). Disable redirects, bound reads, and check active()
before each signature/side effect. The SDK never retries a payment transport.
"""
import base64
import hashlib
import json
import math
import queue
import re
import secrets
import threading
import uuid
import time
from datetime import datetime
from urllib.parse import urlsplit, urlunsplit, quote

ID = re.compile(r'^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')
PROOF_ID = re.compile(r'^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$', re.IGNORECASE)
HASH = re.compile(r'^sha256:[0-9a-f]{64}$')
PHASES = {'prepared', 'signing_started', 'uncertain', 'complete'}
ARTIFACT_LIMITS = {'html': 2000000, 'markdown': 1000000, 'screenshot': 6000000, 'manifest': 1048576}
_TRANSPORT_SLOTS = threading.BoundedSemaphore(8)


class DeltaError(Exception):
    def __init__(self, code, order_id=None, status=None):
        super().__init__('DELTA ' + code + '; retain the original order. Do not authorize a replacement payment.')
        self.code, self.order_id, self.status, self.retryable = code, order_id, status, False


def _json(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'), allow_nan=False)


def _id(value):
    if not isinstance(value, str) or not ID.fullmatch(value.lower()):
        raise DeltaError('invalid_order_id')
    return value.lower()


def _valid_token(value):
    try:
        decoded = base64.urlsafe_b64decode(value + '=')
        return (type(value) is str and re.fullmatch(r'[A-Za-z0-9_-]{43}', value) is not None and
            len(decoded) == 32 and base64.urlsafe_b64encode(decoded).decode().rstrip('=') == value)
    except Exception:
        return False


def _valid_export_operation(value):
    if type(value) is not dict or set(value) != {'operation_id', 'token', 'ttl_seconds', 'expected_generation', 'phase'}:
        return False
    return (type(value['operation_id']) is str and ID.fullmatch(value['operation_id']) is not None and
        _valid_token(value['token']) and type(value['ttl_seconds']) is int and 60 <= value['ttl_seconds'] <= 3600 and
        type(value['expected_generation']) is int and 0 <= value['expected_generation'] < 2**53 - 1 and
        value['phase'] in {'prepared', 'attempted', 'confirmed'})


def _export_authorization_envelope(value, order_id):
    if type(value) is not dict or set(value) != {'ok', 'order_id', 'authorization'} or value['ok'] is not True or value['order_id'] != order_id:
        raise ValueError()
    auth = value['authorization']
    if auth is None:
        return value
    if (type(auth) is not dict or set(auth) != {'operation_id', 'generation', 'expires_at', 'scope', 'state'} or
        type(auth['operation_id']) is not str or ID.fullmatch(auth['operation_id']) is None or
        type(auth['generation']) is not int or not 1 <= auth['generation'] < 2**53 or
        auth['scope'] != ['export'] or auth['state'] not in {'active', 'expired'} or type(auth['expires_at']) is not str):
        raise ValueError()
    expiry = datetime.fromisoformat(auth['expires_at'].replace('Z', '+00:00'))
    if expiry.utcoffset() is None or expiry.utcoffset().total_seconds() != 0:
        raise ValueError()
    return value


def _body(product, value):
    try:
        allowed = {'url'} if product == 'capture' else {'url', 'expected', 'prior_proof_id', 'freshness_seconds'}
        if product not in {'capture', 'preflight'} or type(value) is not dict or set(value) - allowed:
            raise ValueError()
        parsed = urlsplit(value['url'])
        if parsed.scheme not in {'http', 'https'} or not parsed.hostname or parsed.username or parsed.password:
            raise ValueError()
        canonical = dict(value)
        canonical['url'] = urlunsplit((parsed.scheme, parsed.netloc, parsed.path or '/', parsed.query, parsed.fragment))
        result = _json(canonical)
        if len(result.encode()) > 12288:
            raise ValueError()
        return result
    except Exception:
        raise DeltaError('invalid_order_input') from None


def _httpx_transport(method, url, *, headers, body, timeout, active):
    import httpx  # Lazy dependency; injected offline transports need no library.
    deadline, chunks, size = time.monotonic() + timeout, [], 0
    with httpx.stream(method, url, headers=headers, content=body, timeout=timeout, follow_redirects=False) as response:
        for chunk in response.iter_bytes():
            if not active() or time.monotonic() >= deadline:
                raise TimeoutError()
            size += len(chunk)
            limit = ARTIFACT_LIMITS.get(urlsplit(url).path.rsplit('/',1)[-1], 1048576) if '/artifacts/' in urlsplit(url).path else 1048576
            if size > limit:
                raise ValueError()
            chunks.append(chunk)
        return response.status_code, dict(response.headers), b''.join(chunks)


class DeltaWitness:
    def __init__(self, base_url='https://delta-witness-api.ruphussten.workers.dev', *, order_store=None,
                 transport=None, request_timeout=120):
        if type(request_timeout) not in (float, int) or not math.isfinite(request_timeout) or not 0 < request_timeout <= 120:
            raise ValueError('request_timeout must be positive and at most 120 seconds')
        self.base_url = base_url.rstrip('/')
        self.order_store, self.transport = order_store, transport or _httpx_transport
        self.request_timeout = request_timeout

    def _origin(self):
        parsed = urlsplit(self.base_url)
        if parsed.scheme != 'https' or not parsed.hostname or parsed.username or parsed.password or parsed.path or parsed.query or parsed.fragment:
            raise DeltaError('invalid_order_origin')
        return self.base_url

    def _request(self, method, path, *, headers=None, body=None, transport=None, binary=False):
        active, received = threading.Event(), queue.Queue(maxsize=1)
        active.set()
        origin = self._origin()
        if not _TRANSPORT_SLOTS.acquire(blocking=False):
            raise DeltaError('transport_capacity_exhausted')
        def run():
            try:
                response = (transport or self.transport)(method, origin + path,
                    headers={'x-delta-channel': 'pypi', **(headers or {})}, body=body,
                    timeout=self.request_timeout, active=active.is_set)
                received.put_nowait((True, response))
            except Exception:
                received.put_nowait((False, None))
            finally:
                _TRANSPORT_SLOTS.release()
        threading.Thread(target=run, daemon=True).start()
        try:
            ok, response = received.get(timeout=self.request_timeout)
            if not ok:
                raise DeltaError('transport_unconfirmed')
            status, response_headers, raw = response
            limit = ARTIFACT_LIMITS.get(path.rsplit('/',1)[-1], 1048576) if binary else 1048576
            if type(status) is not int or type(raw) is not bytes or len(raw) > limit or 300 <= status < 400:
                raise DeltaError('response_unconfirmed')
            return status, response_headers, raw if binary else json.loads(raw)
        except (queue.Empty, ValueError, TypeError):
            raise DeltaError('response_unconfirmed') from None
        finally:
            active.clear()

    def _store(self):
        if self.order_store is None:
            raise DeltaError('order_store_required')
        return self.order_store

    def _read(self, order_id, missing=False):
        try:
            record = self._store().load(order_id)
        except Exception:
            raise DeltaError('order_store_unavailable', order_id) from None
        if record is None:
            if missing:
                return None
            raise DeltaError('order_not_prepared', order_id)
        try:
            record = json.loads(_json(record))
            fields = {'schema', 'revision', 'order_id', 'origin', 'product', 'request_json', 'request_digest', 'recovery_token', 'phase', 'retention_policy_hash', 'export_authorization'}
            token = record['recovery_token']
            decoded = base64.urlsafe_b64decode(token + '=')
            if (set(record) - fields or record['schema'] != 'delta-python-client-order/v1' or record['order_id'] != order_id or
                type(record['revision']) is not int or not 0 <= record['revision'] < 2**53 or record['phase'] not in PHASES or
                not re.fullmatch(r'[A-Za-z0-9_-]{43}', token) or len(decoded) != 32 or base64.urlsafe_b64encode(decoded).decode().rstrip('=') != token or
                record['origin'] != self._origin() or _body(record['product'], json.loads(record['request_json'])) != record['request_json'] or
                record['request_digest'] != self._digest(record['product'], record['request_json']) or
                ('retention_policy_hash' in record and not HASH.fullmatch(record['retention_policy_hash'])) or
                ('export_authorization' in record and (not _valid_export_operation(record['export_authorization']) or
                    record['export_authorization']['token'] == token))):
                raise ValueError()
            return record
        except Exception:
            raise DeltaError('order_store_invalid', order_id) from None

    def _cas(self, record, revision):
        try:
            saved = self._store().compare_and_set(record['order_id'], revision, json.loads(_json(record)))
            if type(saved) is not bool:
                raise ValueError()
            return saved
        except Exception:
            raise DeltaError('order_store_unavailable', record['order_id']) from None

    def _mark(self, record, phase):
        if record['phase'] == phase:
            return  # Repeated verified reads do not rewrite the durable archive.
        try:
            self._cas({**record, 'revision': record['revision'] + 1, 'phase': phase}, record['revision'])
        except DeltaError:
            pass  # Original signing_started remains authoritative.

    def _digest(self, product, body):
        return 'sha256:' + hashlib.sha256(('delta-python-client-order/v1\n' + self._origin() + '\n' + product + '\n' + body).encode()).hexdigest()

    def prepare_order(self, product, request, *, order_id=None, retention_policy_hash=None):
        oid, origin, body = _id(order_id or str(uuid.uuid4())), self._origin(), _body(product, request)
        if retention_policy_hash is not None and (type(retention_policy_hash) is not str or not HASH.fullmatch(retention_policy_hash)):
            raise DeltaError('invalid_retention_policy_hash', oid)
        old, digest = self._read(oid, True), self._digest(product, body)
        if old is None:
            record = {'schema': 'delta-python-client-order/v1', 'revision': 0, 'order_id': oid, 'origin': origin,
                'product': product, 'request_json': body, 'request_digest': digest,
                'recovery_token': secrets.token_urlsafe(32), 'phase': 'prepared'}
            if retention_policy_hash is not None:
                record['retention_policy_hash'] = retention_policy_hash
            self._cas(record, None)
            old = self._read(oid)
        if old['product'] != product or old['request_digest'] != digest or old['request_json'] != body or old.get('retention_policy_hash') != retention_policy_hash:
            raise DeltaError('order_identity_conflict', oid)
        return {'order_id': oid, 'product': product, 'state': old['phase']}

    def _delivery(self, body, record):
        if type(body) is not dict or body.get('ok') is not True or body.get('product') != record['product']:
            raise ValueError()
        proof = body['proof_id']
        if not isinstance(proof, str) or not PROOF_ID.fullmatch(proof) or body['manifest_url'] != record['origin'] + '/v1/proofs/' + proof or body['public_proof_url'] != record['origin'] + '/p/' + proof:
            raise ValueError()
        if not HASH.fullmatch(body['bundle_root']) or not datetime.fromisoformat(body['observed_at'].replace('Z', '+00:00')).tzinfo:
            raise ValueError()
        if record['product'] == 'preflight' and any(body.get(key, 'missing') is not None and type(body.get(key)) is not bool for key in ('safe', 'changed')):
            raise ValueError()
        if ('reason' in body and type(body['reason']) is not str) or ('idempotent_replay' in body and type(body['idempotent_replay']) is not bool):
            raise ValueError()
        allowed = ('ok', 'product', 'proof_id', 'manifest_url', 'public_proof_url', 'bundle_root', 'observed_at', 'safe', 'changed', 'reason', 'diff', 'idempotent_replay')
        selected = {key: body[key] for key in allowed if key in body}
        if any(token in _json(selected) for token in [record['recovery_token'], record.get('export_authorization', {}).get('token')] if token):
            raise ValueError()
        return {'order_id': record['order_id'], 'product': record['product'], 'state': 'complete', 'delivery': selected}

    def execute_order(self, order_id, paid_transport=None):
        oid = _id(order_id)
        record = self._read(oid)
        if record['phase'] != 'prepared':
            return self.recover_order(oid)
        if not callable(paid_transport):
            raise DeltaError('paid_fetch_required', oid)
        claimed = {**record, 'phase': 'signing_started', 'revision': record['revision'] + 1}
        if not self._cas(claimed, record['revision']):
            return self.recover_order(oid)
        if self._read(oid) != claimed:
            raise DeltaError('order_store_conflict', oid)
        status = None
        try:
            headers = {'content-type': 'application/json', 'x-delta-order-id': oid, 'x-delta-recovery-token': record['recovery_token']}
            if record.get('retention_policy_hash'):
                headers['x-delta-retention-policy-hash'] = record['retention_policy_hash']
            status, _, body = self._request('POST', '/v1/' + record['product'], headers=headers, body=record['request_json'].encode(), transport=paid_transport)
            if status != 200:
                raise ValueError()
            result = self._delivery(body, record)
            self._mark(claimed, 'complete')
            return result
        except Exception:
            self._mark(claimed, 'uncertain')
            raise DeltaError('payment_outcome_unconfirmed', oid, status) from None

    def recover_order(self, order_id):
        oid = _id(order_id)
        record = self._read(oid)
        if record['phase'] == 'prepared':
            self._cas({**record, 'phase': 'uncertain', 'revision': record['revision'] + 1}, record['revision'])
            record = self._read(oid)
            if record['phase'] == 'prepared':
                raise DeltaError('order_store_conflict', oid)
        status = None
        try:
            for recover in (False, True):
                status, _, envelope = self._request('POST' if recover else 'GET', '/v1/orders/' + oid + ('/recover' if recover else ''),
                    headers={'x-delta-recovery-token': record['recovery_token']})
                if (envelope.get('ok') is not True or envelope.get('order_id') != oid or envelope.get('product') != record['product'] or
                    envelope['payment']['treasury_received'] is not None or envelope['payment']['state'] not in {'settlement_unknown', 'settlement_confirmed', 'settlement_rejected'} or
                    type(envelope['recovery']['can_recover']) is not bool or not datetime.fromisoformat(envelope['recovery']['expires_at'].replace('Z', '+00:00')).tzinfo):
                    raise ValueError()
                if status == 200 and envelope['state'] == 'complete' and envelope['fulfillment']['state'] == 'complete' and envelope['payment']['state'] == 'settlement_confirmed' and not envelope['recovery']['can_recover']:
                    result = self._delivery(envelope['delivery'], record)
                    self._mark(record, 'complete')
                    return result
                if (recover or status != 202 or envelope.get('reconciliation_required') is not True or 'delivery' in envelope or
                    envelope['state'] != 'recovery_available' or envelope['fulfillment']['state'] != 'recovery_available' or
                    envelope['payment']['state'] != 'settlement_confirmed' or not envelope['recovery']['can_recover']):
                    raise ValueError()
        except Exception:
            raise DeltaError('order_recovery_unconfirmed', oid, status) from None

    def _read_public(self, path):
        status, _, body = self._request('GET', path)
        if status != 200:
            raise DeltaError('read_failed', status=status)
        return body

    def _read_export_authorization(self, record):
        status, _, body = self._request('GET', '/v1/orders/' + record['order_id'] + '/export-authorization',
            headers={'x-delta-recovery-token': record['recovery_token']})
        if status != 200:
            raise ValueError()
        return _export_authorization_envelope(body, record['order_id'])

    def prepare_export_authorization(self, order_id, *, operation_id, ttl_seconds=300):
        """Persist one private operation before any update; no payment transport."""
        oid, op_id = _id(order_id), _id(operation_id)
        if type(ttl_seconds) is not int or not 60 <= ttl_seconds <= 3600:
            raise DeltaError('invalid_export_authorization', oid)
        record = self._read(oid)
        prior = record.get('export_authorization')
        if prior and prior['operation_id'] == op_id:
            if prior['ttl_seconds'] != ttl_seconds:
                raise DeltaError('export_authorization_identity_conflict', oid)
            return {'order_id': oid, 'operation_id': op_id, 'state': prior['phase']}
        if prior and prior['phase'] != 'confirmed':
            raise DeltaError('export_authorization_pending', oid)
        try:
            current = self._read_export_authorization(record)['authorization']
        except Exception:
            raise DeltaError('export_authorization_unconfirmed', oid) from None
        token = secrets.token_urlsafe(32)
        if not _valid_token(token) or token == record['recovery_token']:
            raise DeltaError('invalid_export_authorization', oid)
        operation = {'operation_id': op_id, 'token': token, 'ttl_seconds': ttl_seconds,
            'expected_generation': current['generation'] if current else 0, 'phase': 'prepared'}
        next_record = {**record, 'revision': record['revision'] + 1, 'export_authorization': operation}
        if not self._cas(next_record, record['revision']):
            raise DeltaError('order_store_conflict', oid)
        if self._read(oid) != next_record:
            raise DeltaError('order_store_conflict', oid)
        return {'order_id': oid, 'operation_id': op_id, 'state': 'prepared'}

    def _accept_export_authorization(self, record, body):
        operation = record['export_authorization']
        auth = _export_authorization_envelope(body, record['order_id'])['authorization']
        if auth is None or auth['operation_id'] != operation['operation_id'] or auth['generation'] != operation['expected_generation'] + 1:
            raise ValueError()
        if operation['phase'] != 'confirmed':
            if not self._cas({**record, 'revision': record['revision'] + 1,
                'export_authorization': {**operation, 'phase': 'confirmed'}}, record['revision']):
                raise ValueError()
        return body

    def execute_export_authorization(self, order_id):
        oid, status = _id(order_id), None
        record = self._read(oid)
        operation = record.get('export_authorization')
        if not operation:
            raise DeltaError('export_authorization_not_prepared', oid)
        if operation['phase'] != 'prepared':
            return self.recover_export_authorization(oid)
        claimed = {**record, 'revision': record['revision'] + 1,
            'export_authorization': {**operation, 'phase': 'attempted'}}
        if not self._cas(claimed, record['revision']):
            raise DeltaError('order_store_conflict', oid)
        if self._read(oid) != claimed:
            raise DeltaError('order_store_conflict', oid)
        try:
            payload = {key: operation[key] for key in ('operation_id', 'token', 'ttl_seconds', 'expected_generation')}
            status, _, body = self._request('POST', '/v1/orders/' + oid + '/export-authorization',
                headers={'content-type': 'application/json', 'x-delta-recovery-token': record['recovery_token']},
                body=_json(payload).encode())
            if status not in (200, 201):
                raise ValueError()
            return self._accept_export_authorization(claimed, body)
        except Exception:
            raise DeltaError('export_authorization_unconfirmed', oid, status) from None

    def recover_export_authorization(self, order_id):
        oid = _id(order_id)
        record = self._read(oid)
        if not record.get('export_authorization'):
            raise DeltaError('export_authorization_not_prepared', oid)
        try:
            return self._accept_export_authorization(record, self._read_export_authorization(record))
        except Exception:
            raise DeltaError('export_authorization_unconfirmed', oid) from None

    def export_artifact(self, order_id, artifact, *, use_export_authorization=False):
        oid = _id(order_id)
        if artifact not in {'html', 'markdown', 'screenshot', 'manifest'}:
            raise DeltaError('invalid_order_artifact', oid)
        record = self._read(oid)
        token = record['recovery_token']
        if type(use_export_authorization) is not bool:
            raise DeltaError('invalid_export_authorization', oid)
        if use_export_authorization:
            operation = record.get('export_authorization')
            if not operation or operation['phase'] != 'confirmed':
                raise DeltaError('export_authorization_unconfirmed', oid)
            token = operation['token']
        names = {'html': 'page.html', 'markdown': 'page.md', 'screenshot': 'screenshot.png', 'manifest': 'manifest.json'}
        filename = 'delta-' + oid + '-' + names[artifact]
        status = None
        try:
            status, headers, raw = self._request('GET', '/v1/orders/' + oid + '/artifacts/' + artifact,
                headers={'x-delta-recovery-token': token}, binary=True)
            headers = {key.lower(): value for key, value in headers.items()}
            digest = 'sha256:' + hashlib.sha256(raw).hexdigest()
            if (status != 200 or headers.get('x-delta-content-sha256') != digest or
                headers.get('content-length') != str(len(raw)) or
                not headers.get('content-disposition','').startswith('attachment;')):
                raise ValueError()
            return {'order_id': oid, 'artifact': artifact, 'filename': filename, 'content_sha256': digest, 'content_type': 'application/octet-stream', 'bytes': raw}
        except Exception:
            raise DeltaError('order_export_unconfirmed', oid, status) from None

    def quote(self, product='capture'):
        if product not in {'capture', 'preflight'}:
            raise ValueError('product must be capture or preflight')
        return self._read_public('/v1/quote?product=' + product)

    def demo(self):
        return self._read_public('/v1/demo')

    def proof(self, proof_id):
        return self._read_public('/v1/proofs/' + quote(proof_id, safe=''))

    def payment_challenge(self, url, product='capture', **options):
        body = _body(product, {'url': url, **options})
        status, headers, result = self._request('POST', '/v1/' + product, headers={'content-type': 'application/json'}, body=body.encode())
        if status != 402:
            raise DeltaError('challenge_unconfirmed', status=status)
        return {'status': status, 'headers': headers, 'body': result}

    def preflight_challenge(self, url, **options):
        return self.payment_challenge(url, product='preflight', **options)
