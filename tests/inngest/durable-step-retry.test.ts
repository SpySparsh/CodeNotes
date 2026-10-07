import { describe, it, expect, vi } from 'vitest';

describe('Inngest Durable Step Execution & Resume Mechanics', () => {
  it('resumes from the failed step and does NOT re-execute previously succeeded steps', async () => {
    const step1ExecutionCount = vi.fn();
    const step2ExecutionCount = vi.fn();
    const step3ExecutionCount = vi.fn();

    // Simulated Inngest Step Memoization Engine
    const memoizedStepResults: Record<string, any> = {};

    const createStepRunner = () => ({
      run: async (stepId: string, fn: () => Promise<any>) => {
        if (stepId in memoizedStepResults) {
          // Inngest memoized replay: return cached output without executing fn
          return memoizedStepResults[stepId];
        }
        const result = await fn();
        memoizedStepResults[stepId] = result;
        return result;
      },
    });

    const workflowHandler = async (step: any, shouldStep2Fail: boolean) => {
      // Step 1
      const res1 = await step.run('step-1-claim', async () => {
        step1ExecutionCount();
        return { claimed: true, id: '123' };
      });

      // Step 2
      const res2 = await step.run('step-2-fetch', async () => {
        step2ExecutionCount();
        if (shouldStep2Fail) {
          throw new Error('Transient network glitch during fetch');
        }
        return { data: 'transcript_text' };
      });

      // Step 3
      const res3 = await step.run('step-3-persist', async () => {
        step3ExecutionCount();
        return { persisted: true };
      });

      return { res1, res2, res3 };
    };

    // Execution Attempt 1: Step 1 succeeds, Step 2 fails
    const runner1 = createStepRunner();
    await expect(workflowHandler(runner1, true)).rejects.toThrow('Transient network glitch during fetch');

    expect(step1ExecutionCount).toHaveBeenCalledTimes(1);
    expect(step2ExecutionCount).toHaveBeenCalledTimes(1);
    expect(step3ExecutionCount).toHaveBeenCalledTimes(0);
    expect(memoizedStepResults['step-1-claim']).toEqual({ claimed: true, id: '123' });

    // Execution Attempt 2 (Retry): Resumes from Step 2 without re-executing Step 1
    const runner2 = createStepRunner();
    const finalResult = await workflowHandler(runner2, false);

    expect(step1ExecutionCount).toHaveBeenCalledTimes(1); // STILL 1 (NOT re-executed)
    expect(step2ExecutionCount).toHaveBeenCalledTimes(2); // Retried
    expect(step3ExecutionCount).toHaveBeenCalledTimes(1); // Now executed
    expect(finalResult.res3.persisted).toBe(true);
  });
});
