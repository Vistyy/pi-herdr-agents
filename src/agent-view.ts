import { HERDR_METADATA_SOURCE, type AgentViewState, HerdrSocketClient } from "./herdr.js";

export interface AgentViewControllerApi {
  setOwnedAgentView(): Promise<AgentViewState>;
  clearAgentView(source: string): Promise<AgentViewState>;
}

/** Owns the extension's transient Agents sidebar projection. */
export class OwnedAgentViewController {
  private ownershipAttempted = false;

  constructor(private readonly api: AgentViewControllerApi) {}

  static fromEnvironment(): OwnedAgentViewController {
    return new OwnedAgentViewController(new HerdrSocketClient());
  }

  async install(): Promise<void> {
    // Source-guarded clear is the only raw API operation that can inspect the
    // current owner without replacing another source's projection.
    const previous = await this.api.clearAgentView(HERDR_METADATA_SOURCE);
    if (previous.active && previous.source !== HERDR_METADATA_SOURCE) {
      throw new Error(`Herdr Agents sidebar is owned by another source (${previous.source ?? "unknown"}); leaving its projection unchanged.`);
    }
    this.ownershipAttempted = true;
    let installed: AgentViewState;
    try {
      installed = await this.api.setOwnedAgentView();
    } catch (error) {
      throw new Error(`Herdr sidebar ownership may have succeeded without a response: ${(error as Error).message}`);
    }
    if (!installed.active || installed.source !== HERDR_METADATA_SOURCE) {
      throw new Error("Herdr set response did not confirm the pi-herdr-agents Agents sidebar projection; ownership may still have succeeded.");
    }
  }

  async clearOwned(): Promise<void> {
    if (!this.ownershipAttempted) return;
    const result = await this.api.clearAgentView(HERDR_METADATA_SOURCE);
    if (result.active && result.source !== HERDR_METADATA_SOURCE) {
      throw new Error(`Herdr Agents sidebar changed owner to ${result.source ?? "unknown"}; it was not cleared.`);
    }
  }
}
