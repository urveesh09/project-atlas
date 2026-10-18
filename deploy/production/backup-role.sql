-- Run once as the ATLAS schema owner in the ATLAS database, not as the API role.
-- Adapt the database name if necessary. Provision login credentials separately with
-- psql's \password, then ALTER ROLE atlas_backup LOGIN; never put passwords in SQL files.
CREATE ROLE atlas_backup NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
GRANT CONNECT ON DATABASE atlas TO atlas_backup;
GRANT USAGE ON SCHEMA public TO atlas_backup;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO atlas_backup;
GRANT SELECT ON ALL SEQUENCES IN SCHEMA public TO atlas_backup;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO atlas_backup;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON SEQUENCES TO atlas_backup;
