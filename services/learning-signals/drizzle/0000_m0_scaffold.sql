-- M0 initializes the PostgreSQL-only migration ledger without creating domain
-- tables ahead of their milestones. When session_events is introduced, it is
-- intentionally unpartitioned for pilot volume; month-range partitioning is
-- the documented scale path.
select 1;

