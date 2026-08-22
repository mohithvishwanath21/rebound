/**
 * Pure enums, no dependencies.
 *
 * These started life in `src/db/models/world.js`, which meant that importing
 * `LossType` dragged in mongoose — and therefore that computing a recovery
 * probability required a database driver to be installed. That made the response
 * model's unit tests slow to set up and conceptually wrong: a probability
 * calculation has no business depending on a persistence layer.
 *
 * Splitting them out keeps `src/sim/` and `src/agent/` runnable with zero
 * infrastructure, which matters more than it sounds: fast, dependency-free tests are
 * the difference between verifying invariants continuously and verifying them once.
 *
 * `world.js` re-exports these so existing import sites keep working.
 */

export const LossType = {
  FAILED_PAYMENT: 'FAILED_PAYMENT',
  FAILED_SUBSCRIPTION: 'FAILED_SUBSCRIPTION',
  OVERDUE_INVOICE: 'OVERDUE_INVOICE',
};

export const Rail = {
  UPI: 'UPI',
  CARD: 'CARD',
  NETBANKING: 'NETBANKING',
};

export const Segment = {
  B2C: 'B2C',
  B2B: 'B2B',
};

export const LOSS_TYPES = Object.values(LossType);
export const RAILS = Object.values(Rail);
export const SEGMENTS = Object.values(Segment);
