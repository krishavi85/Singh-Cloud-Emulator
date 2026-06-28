import('/workbench-app.js').catch((error) => {
  console.error('Workbench startup failed:', error);
  const root = document.querySelector('#workbenchContent');
  if (root) root.textContent = 'Workbench could not start.';
});
