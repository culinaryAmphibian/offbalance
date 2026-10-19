const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;

/** Pending jobs only; the durable job service rehydrates this queue on startup. */
export class JobQueue {
  #jobs = new Map();

  add(job) {
    if (!job?.id) throw new TypeError('A queued job needs an id.');
    if (!this.#jobs.has(job.id)) this.#jobs.set(job.id, structuredClone(job));
    return this.peek();
  }

  remove(id) { return this.#jobs.delete(id); }

  getPending() {
    return [...this.#jobs.values()]
      .sort((a, b) => compare(a.createdAt ?? '', b.createdAt ?? '') || compare(a.id, b.id))
      .map(job => structuredClone(job));
  }

  peek() { return this.getPending()[0] ?? null; }
}

export default JobQueue;
