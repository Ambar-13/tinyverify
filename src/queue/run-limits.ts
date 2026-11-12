/** Kept apart from budget.ts, which needs the Worker types, so the node scripts can import it too. */

/**
 * How a run is limited and what is held for it. With AGENT_STEP_CAP "on" the account has TinyFish's custom
 * step cap, so the run is capped at maxSteps and exactly that many steps are held. Otherwise the run gets a
 * time limit (6 seconds for each step), the goal asks the agent to stop after maxSteps actions, and twice the
 * steps are held, because nothing enforces the count.
 */
export function runLimits(
  maxSteps: number,
  stepCap: string | undefined,
): { agent_config: { max_steps?: number; max_duration_seconds?: number }; held_steps: number; goal_suffix: string } {
  if (stepCap === 'on') return { agent_config: { max_steps: maxSteps }, held_steps: maxSteps, goal_suffix: '' };
  return {
    agent_config: { max_duration_seconds: maxSteps * 6 },
    held_steps: maxSteps * 2,
    goal_suffix:
      '\n\nUse at most ' + maxSteps + ' actions. If the task is not finished by then, stop and report what you have.',
  };
}
