\getenv readonly_password POSTGRES_READONLY_PASSWORD
CREATE ROLE datapilot_reader LOGIN PASSWORD :'readonly_password';
GRANT CONNECT ON DATABASE datapilot TO datapilot_reader;
ALTER DEFAULT PRIVILEGES FOR ROLE datapilot_app IN SCHEMA public GRANT SELECT ON TABLES TO datapilot_reader;
