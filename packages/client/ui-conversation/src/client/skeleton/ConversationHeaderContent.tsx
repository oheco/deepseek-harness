import type { ConversationHeaderContentProps } from '../contract/slots.ts'

/**
 * Render the registered native header in the occurrence's inherited Session scope.
 * @param props - Factory-bound child renderer.
 * @returns the native header, including its registered replacements and contributions.
 */
export function ConversationHeaderContent({ renderSlot }: ConversationHeaderContentProps) {
  return renderSlot('conversation.header', {})
}
