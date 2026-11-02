"""Private durable identities; this module never signs or pays."""
import json
import os
import sqlite3
from pathlib import Path
from contextlib import contextmanager


class SQLiteOrderStore:
    """Local SQLite CAS. Owner must restrict directory/Windows ACL and retain DB."""
    def __init__(self, path):
        self.path = Path(path)
        if not self.path.is_absolute() or self.path.is_symlink():
            raise ValueError('private_absolute_store_path_required')
        self.path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        if not self.path.exists():
            try:
                fd = os.open(self.path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
                os.close(fd)
            except FileExistsError:
                pass
        with self._connection() as db:
            db.execute('CREATE TABLE IF NOT EXISTS client_orders (id TEXT PRIMARY KEY, revision INTEGER NOT NULL, record TEXT NOT NULL)')

    @contextmanager
    def _connection(self):
        if self.path.is_symlink():
            raise ValueError('private_store_symlink')
        db = sqlite3.connect(self.path, timeout=5)
        db.execute('PRAGMA synchronous=FULL')
        try:
            with db:
                yield db
        finally:
            db.close()

    def load(self, order_id):
        with self._connection() as db:
            row = db.execute('SELECT record FROM client_orders WHERE id=?', (order_id,)).fetchone()
        return None if row is None else json.loads(row[0])

    def compare_and_set(self, order_id, revision, record):
        value = json.dumps(record, separators=(',', ':'), allow_nan=False)
        if len(value.encode()) > 32768 or record['order_id'] != order_id or record['revision'] != (0 if revision is None else revision + 1):
            raise ValueError('invalid_order_record')
        with self._connection() as db:
            db.execute('BEGIN IMMEDIATE')
            if revision is None:
                result = db.execute('INSERT OR IGNORE INTO client_orders VALUES (?,?,?)', (order_id, 0, value))
            else:
                result = db.execute('UPDATE client_orders SET revision=?, record=? WHERE id=? AND revision=?', (revision + 1, value, order_id, revision))
            return result.rowcount == 1
