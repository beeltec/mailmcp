export const toolGroups = {
  'Read mail': ['list_mailboxes', 'get_mailbox', 'search_messages', 'search_mailboxes', 'read_message', 'read_messages', 'save_attachment'],
  'Organize mail': ['set_message_state', 'move_message', 'trash_message'],
  'Manage folders': ['create_mailbox', 'rename_mailbox', 'delete_mailbox'],
  'Drafts and sending': ['create_draft', 'reply_to_message', 'forward_message', 'get_draft', 'add_attachment', 'send_draft'],
} as const;

export const toolNames = Object.values(toolGroups).flat();
export type ToolName = typeof toolNames[number];
export const destructiveTools: readonly ToolName[] = ['trash_message', 'delete_mailbox'];
