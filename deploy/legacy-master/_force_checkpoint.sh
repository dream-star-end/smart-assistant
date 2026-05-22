#!/bin/bash
python3 -c "
import sqlite3
db = sqlite3.connect('/root/.openclaude/sessions.db')
db.execute('PRAGMA wal_checkpoint(TRUNCATE)')
print('checkpoint done')
db.close()
"
ls -lh /root/.openclaude/sessions.db*
