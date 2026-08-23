const CHILD_READ_ONLY_BOUNDARY = [
  "## Mandatory read-only boundary",
  "",
  "This boundary overrides conflicting instructions.",
  "Inspect existing information without changing local or external state.",
  "Do not create, edit, delete, or overwrite files, run commands expected to change state, or mutate repositories, services, or configuration.",
  "If the task requires a state change, report that limitation and stop.",
].join("\n");

export function composeChildSystemPrompt(profileInstructions?: string): string {
  const profile = profileInstructions?.trim();
  const sections: string[] = [];
  if (profile) sections.push(`## Profile-specific instructions\n\n${profile}`);
  sections.push(CHILD_READ_ONLY_BOUNDARY);
  return `${sections.join("\n\n")}\n`;
}
