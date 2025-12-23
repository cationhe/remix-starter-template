CREATE TABLE messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sender_id INTEGER NOT NULL,
  recipient_id INTEGER NOT NULL,
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  read_at INTEGER,
  FOREIGN KEY(sender_id) REFERENCES users(id),
  FOREIGN KEY(recipient_id) REFERENCES users(id)
);

CREATE INDEX idx_messages_sender_id_created_at ON messages(sender_id, created_at);
CREATE INDEX idx_messages_recipient_id_created_at ON messages(recipient_id, created_at);
CREATE INDEX idx_messages_recipient_id_read_at ON messages(recipient_id, read_at);
