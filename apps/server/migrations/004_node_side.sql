-- 004_node_side: which side of the root a top-level branch is drawn on in the mind map (null = automatic).
alter table node add column side text check (side in ('left', 'right'));
