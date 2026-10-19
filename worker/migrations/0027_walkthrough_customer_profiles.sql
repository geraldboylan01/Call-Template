-- Contact details extend the existing private planning profile, without a second
-- account or changes to confirmed financial inputs. No cross-session matching.
CREATE TABLE education_customer_profiles (
  source_type TEXT NOT NULL CHECK (source_type IN ('consumer', 'published')),
  source_id TEXT NOT NULL,
  contact_encrypted TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (source_type, source_id)
);
