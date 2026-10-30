-- Preserve immutable presentation records during a code rollback.
-- Earlier code tolerates this nullable additive column; use a reviewed forward repair.
SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'DAO presentation history is retained; use a reviewed forward migration';
