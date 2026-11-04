import type { ProfileId, AIProfileModule, AIToolDefinition } from './types';
import { coreProfile } from './profiles/core';
import { sanitizerProfile } from './profiles/sanitizer';
import { formulaProProfile } from './profiles/formula_pro';
import { architectProfile } from './profiles/architect';
import { analystProfile } from './profiles/analyst';
import { visualizerProfile } from './profiles/visualizer';
import { auditorProfile } from './profiles/auditor';

export const PROFILE_REGISTRY: Record<ProfileId, AIProfileModule> = {
  core: coreProfile,
  sanitizer: sanitizerProfile,
  formula_pro: formulaProProfile,
  architect: architectProfile,
  analyst: analystProfile,
  visualizer: visualizerProfile,
  auditor: auditorProfile,
};

export function getProfile(id: ProfileId): AIProfileModule {
  return PROFILE_REGISTRY[id] || PROFILE_REGISTRY.core;
}

export function getAllProfiles(): AIProfileModule[] {
  return Object.values(PROFILE_REGISTRY);
}

/**
 * Returns all active tools for a given profile session:
 * Always includes the Core Vectorized tools plus any profile-specific tools,
 * deduplicated cleanly by name.
 */
export function getActiveToolsForProfile(profileId: ProfileId): AIToolDefinition[] {
  const activeProfile = getProfile(profileId);
  const coreTools = PROFILE_REGISTRY.core.tools;

  if (profileId === 'core') {
    return coreTools;
  }

  const toolMap = new Map<string, AIToolDefinition>();
  for (const tool of coreTools) {
    toolMap.set(tool.name, tool);
  }
  for (const tool of activeProfile.tools) {
    toolMap.set(tool.name, tool);
  }

  return Array.from(toolMap.values());
}

/**
 * Resolves a tool by name across the active profile first, then falls back
 * across all 7 profiles so cross-profile tool calls never fail with "not registered".
 */
export function findToolAcrossAllProfiles(
  toolName: string,
  preferredProfileId: ProfileId
): { tool: AIToolDefinition; ownerProfileId: ProfileId } | null {
  const activeTools = getActiveToolsForProfile(preferredProfileId);
  const inActive = activeTools.find((t) => t.name === toolName);
  if (inActive) {
    return { tool: inActive, ownerProfileId: preferredProfileId };
  }

  for (const profile of Object.values(PROFILE_REGISTRY)) {
    const found = profile.tools.find((t) => t.name === toolName);
    if (found) {
      return { tool: found, ownerProfileId: profile.id };
    }
  }
  return null;
}
