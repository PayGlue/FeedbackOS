import { defineMessages } from 'react-intl'

/** The Approvals page's strings, and the ones the rail and Home share with it. */
export const approvalMessages = defineMessages({
  title: { id: 'admin.approvals.title', defaultMessage: 'Approvals' },
  waiting: { id: 'admin.approvals.tabs.waiting', defaultMessage: 'Waiting' },
  decided: { id: 'admin.approvals.tabs.decided', defaultMessage: 'Decided' },
  emptyWaiting: { id: 'admin.approvals.empty.waiting', defaultMessage: 'Nothing waiting.' },
  emptyDecided: { id: 'admin.approvals.empty.decided', defaultMessage: 'Nothing decided yet.' },
  back: { id: 'admin.approvals.back', defaultMessage: 'Back to approvals' },
  riskLow: { id: 'admin.approvals.risk.low', defaultMessage: 'Low' },
  riskMedium: { id: 'admin.approvals.risk.medium', defaultMessage: 'Medium' },
  riskHigh: { id: 'admin.approvals.risk.high', defaultMessage: 'High' },
  riskCritical: { id: 'admin.approvals.risk.critical', defaultMessage: 'Critical' },
  areaSettings: { id: 'admin.approvals.area.settings', defaultMessage: 'Settings › {areas}' },
  areaConversation: { id: 'admin.approvals.area.conversation', defaultMessage: 'Conversation' },
  areaTicket: { id: 'admin.approvals.area.ticket', defaultMessage: 'Ticket' },
  someone: { id: 'admin.approvals.someone', defaultMessage: 'Someone' },
  requestedBy: { id: 'admin.approvals.requestedBy', defaultMessage: 'Requested by <b>{name}</b>' },
  for: { id: 'admin.approvals.for', defaultMessage: 'For <b>{name}</b>' },
  requesterFor: { id: 'admin.approvals.requesterFor', defaultMessage: '{requester} for {person}' },
  expires: { id: 'admin.approvals.expires', defaultMessage: 'Expires {when}' },
  approvedBy: { id: 'admin.approvals.approvedBy', defaultMessage: 'Approved by {name}' },
  rejectedBy: { id: 'admin.approvals.rejectedBy', defaultMessage: 'Rejected by {name}' },
  reasonGiven: { id: 'admin.approvals.reasonGiven', defaultMessage: 'Reason: {reason}' },
  changes: { id: 'admin.approvals.changes', defaultMessage: 'Changes' },
  approve: { id: 'admin.approvals.approve', defaultMessage: 'Approve' },
  reject: { id: 'admin.approvals.reject', defaultMessage: 'Reject' },
  cancel: { id: 'admin.approvals.cancel', defaultMessage: 'Cancel' },
  undo: { id: 'admin.approvals.undo', defaultMessage: 'Undo' },
  reasonLabel: { id: 'admin.approvals.reason.label', defaultMessage: 'Reason, sent to {name}' },
  reasonPlaceholder: { id: 'admin.approvals.reason.placeholder', defaultMessage: 'Optional' },
  statusApplied: { id: 'admin.approvals.status.applied', defaultMessage: 'Applied' },
  statusApproved: { id: 'admin.approvals.status.approved', defaultMessage: 'Approved' },
  statusRejected: { id: 'admin.approvals.status.rejected', defaultMessage: 'Rejected' },
  statusUndone: { id: 'admin.approvals.status.undone', defaultMessage: 'Undone' },
  statusFailed: { id: 'admin.approvals.status.failed', defaultMessage: 'Failed' },
  applied: {
    id: 'admin.approvals.result.applied',
    defaultMessage: 'Applied just now.',
  },
  appliedFinal: {
    id: 'admin.approvals.result.appliedFinal',
    defaultMessage: 'Done. It can’t be undone.',
  },
  rejected: {
    id: 'admin.approvals.result.rejected',
    defaultMessage: 'Rejected.',
  },
  undone: {
    id: 'admin.approvals.result.undone',
    defaultMessage: 'Undone. The previous values are back.',
  },
  failed: {
    id: 'admin.approvals.result.failed',
    defaultMessage: 'Approved, but it could not be completed.',
  },
  errorChanged: {
    id: 'admin.approvals.error.changed',
    defaultMessage: 'This request changed. Review it again.',
  },
  errorSignIn: { id: 'admin.approvals.error.signIn', defaultMessage: 'Sign in again to approve' },
  errorAdmin: {
    id: 'admin.approvals.error.admin',
    defaultMessage: 'An admin must decide this request.',
  },
  errorPermission: {
    id: 'admin.approvals.error.permission',
    defaultMessage: 'You need permission for every change in this request.',
  },
  errorSelf: {
    id: 'admin.approvals.error.self',
    defaultMessage: 'Someone else must decide this request.',
  },
  errorGone: {
    id: 'admin.approvals.error.gone',
    defaultMessage: 'This request was already decided or has expired.',
  },
  errorUnavailable: {
    id: 'admin.approvals.error.unavailable',
    defaultMessage: 'This request can only be decided where it was made.',
  },
  errorFailed: {
    id: 'admin.approvals.error.failed',
    defaultMessage: 'That did not go through. Try again.',
  },
})

/** The words for a refusal the server sent back as a code. */
export function refusalMessage(code: string) {
  switch (code) {
    case 'APPROVAL_CONTENT_CHANGED':
      return approvalMessages.errorChanged
    case 'RECENT_SIGN_IN_REQUIRED':
      return approvalMessages.errorSignIn
    case 'APPROVAL_ADMIN_REQUIRED':
      return approvalMessages.errorAdmin
    case 'APPROVAL_PERMISSION_REQUIRED':
    case 'ASSISTANT_ACTION_PERMISSION_DENIED':
    case 'SETTINGS_PERMISSION_REQUIRED':
      return approvalMessages.errorPermission
    case 'APPROVAL_SELF_DECISION':
    case 'APPROVAL_PERSON_REQUIRED':
      return approvalMessages.errorSelf
    case 'PENDING_ACTION_NOT_DECIDABLE':
    case 'PENDING_ACTION_NOT_FOUND':
    case 'APPROVAL_NOT_FOUND':
      return approvalMessages.errorGone
    case 'APPROVAL_NOT_AVAILABLE':
    case 'ASSISTANT_ACTION_POLICY_CHANGED':
    case 'ASSISTANT_TOOL_GONE':
      return approvalMessages.errorUnavailable
    default:
      return approvalMessages.errorFailed
  }
}
