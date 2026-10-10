import type { Role } from './types';

export const PLAN_STATUSES = [
  'draft',
  'awaiting_approval',
  'approved',
  'rejected',
  'completed',
  'cancelled',
] as const;
export type PlanStatus = (typeof PLAN_STATUSES)[number];
export type PlanAction = 'submit' | 'approve' | 'reject' | 'cancel' | 'complete';

const TRANSITIONS: Record<PlanAction, { from: PlanStatus[]; to: PlanStatus }> = {
  submit: { from: ['draft'], to: 'awaiting_approval' },
  approve: { from: ['awaiting_approval'], to: 'approved' },
  reject: { from: ['awaiting_approval'], to: 'rejected' },
  cancel: { from: ['draft', 'awaiting_approval', 'approved'], to: 'cancelled' },
  complete: { from: ['approved'], to: 'completed' },
};

export const PLAN_STATUS_LABELS: Record<PlanStatus, string> = {
  draft: 'Draft',
  awaiting_approval: 'Awaiting approval',
  approved: 'Approved',
  rejected: 'Rejected',
  completed: 'Completed',
  cancelled: 'Cancelled',
};

export class TransitionError extends Error {
  constructor(
    message: string,
    public readonly code: 'invalid_transition' | 'forbidden' | 'reason_required',
  ) {
    super(message);
    this.name = 'TransitionError';
  }
}

export function canApprove(role: Role, managersCanApprove: boolean): boolean {
  return role === 'owner' || (role === 'manager' && managersCanApprove);
}

/** Validates a transition and returns the next status. Throws TransitionError. */
export function nextStatus(
  current: PlanStatus,
  action: PlanAction,
  ctx: { role: Role; managersCanApprove: boolean; reason?: string | null },
): PlanStatus {
  const t = TRANSITIONS[action];
  if (!t.from.includes(current)) {
    throw new TransitionError(
      `Cannot ${action} a plan that is ${PLAN_STATUS_LABELS[current].toLowerCase()}.`,
      'invalid_transition',
    );
  }
  if (ctx.role === 'staff')
    throw new TransitionError('Staff members cannot change plan status.', 'forbidden');
  if ((action === 'approve' || action === 'reject') && !canApprove(ctx.role, ctx.managersCanApprove)) {
    throw new TransitionError('Only the owner can approve or reject plans at this outlet.', 'forbidden');
  }
  if (action === 'cancel' && current === 'approved' && !canApprove(ctx.role, ctx.managersCanApprove)) {
    throw new TransitionError('Only an approver can cancel an approved plan.', 'forbidden');
  }
  if ((action === 'reject' || action === 'cancel') && !ctx.reason?.trim()) {
    throw new TransitionError(`A reason is required to ${action} a plan.`, 'reason_required');
  }
  return t.to;
}
