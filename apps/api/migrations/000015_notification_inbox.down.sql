-- Forward-only preservation: do not destroy preferences, acknowledgements,
-- canonical presentation revisions or legacy rows during application rollback.
SIGNAL SQLSTATE '45000'
    SET MESSAGE_TEXT = 'Notification schema is retained. Review data preservation before any schema downgrade.';
