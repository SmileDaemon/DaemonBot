// Work to finish (e.g. saving tracker sessions in progress) when the bot is stopped with Ctrl+C or pm2.
const tasks = [];

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    for (const task of tasks) {
      try {
        task();
      } catch (err) {
        console.error('Error while shutting down:', err);
      }
    }
    process.exit(0);
  });
}

export const onShutdown = (task) => tasks.push(task);
