-- Forward-only history: a schema rollback must not erase an unresolved or
-- completed principal observation. Repair through a reviewed forward migration.
SIGNAL SQLSTATE '45000'
  SET MESSAGE_TEXT = 'Principal observation history is forward-only; preserve records and apply a reviewed forward repair';
