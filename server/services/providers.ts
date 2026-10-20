import { Router } from 'express';
import { numericJobId } from '../adapters/repository.ts';
import { requireAuth } from '../middleware/auth.ts';
import { loadJob } from '../routes/deps.ts';
import type { Matcher } from './matcher.ts';

/** Provider control shares the API's HTTPS listener and bearer authentication. */
export function providerControlRoutes(matcher: Matcher): Router {
  const router = Router();

  router.get('/provider/assignment', requireAuth, async (_req, res) => {
    const assignment = await matcher.repository.getActiveAssignment(String(res.locals.account._id));
    res.json({ assignment });
  });

  for (const action of ['accept', 'idle', 'error'] as const) {
    router.post(`/provider/jobs/:jobId/${action}`, requireAuth, async (req, res) => {
      if (numericJobId(String(req.params.jobId)) === null) {
        res.status(400).json({ error: 'jobId must be a non-negative safe integer' });
        return;
      }
      const job = await loadJob(req, res);
      if (!job) return;
      const assignment = await matcher.repository.getAssignedJob(job.onChainJobId, String(res.locals.account._id));
      if (!assignment) {
        res.status(403).json({ error: 'this job is not assigned to the provider' });
        return;
      }
      if (action === 'error') {
        const message: unknown = req.body?.message;
        if (typeof message !== 'string' || !message.trim() || message.length > 4096) {
          res.status(400).json({ error: 'message must contain 1 to 4096 characters' });
          return;
        }
        console.error(`Provider ${res.locals.account._id}, job ${job.onChainJobId}: ${message}`);
      }
      // A provider acknowledgement cannot release unfinished on-chain work.
      // Contract lifecycle events remain the authority for assignment status.
      res.json({ ok: true, assignment });
    });
  }

  return router;
}
