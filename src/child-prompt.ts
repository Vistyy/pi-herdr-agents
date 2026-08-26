export function composeChildSystemPrompt(options: {
  globalInstructions?: string;
  identityInstructions?: string;
} = {}): string | undefined {
  const sections = [options.globalInstructions, options.identityInstructions]
    .map((section) => section?.trim())
    .filter((section): section is string => Boolean(section));
  return sections.length > 0 ? `${sections.join("\n\n")}\n` : undefined;
}
