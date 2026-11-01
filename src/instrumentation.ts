export const register = async () => {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    try {
      console.log('Running database migrations...');
      await import('./lib/db/migrate');
      console.log('Database migrations completed successfully');
    } catch (error) {
      console.error('Failed to run database migrations:', error);
    }

    await import('./lib/config/index');

    /* Start loading the cross-encoder reranker in the background (only when
       it is the configured reranker). Not awaited: startup never waits for
       it, and warmUpReranker logs its own result and never throws. */
    try {
      const { warmUpReranker } = await import('./lib/rerank/warmup');
      void warmUpReranker();
    } catch (error) {
      console.warn('Reranker warm-up could not start:', error);
    }
  }
};
