/**
 * The wire contract shared by `apps/server` and `apps/client` (milestone B
 * spec, part 1 §1). It is the only module either side imports for wire shapes,
 * and it depends on the simulation at type level only, so no engine structure
 * reaches the network (P-01).
 */
export * from './codes';
export * from './public-state';
export * from './rest';
export * from './ws';
