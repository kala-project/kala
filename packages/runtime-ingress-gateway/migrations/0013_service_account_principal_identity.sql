-- Human issuer/subject identities remain unique; service accounts have neither.
ALTER TABLE principals DROP CONSTRAINT principals_issuer_subject_key;
ALTER TABLE principals ADD CONSTRAINT principals_issuer_subject_key UNIQUE (issuer, subject);
