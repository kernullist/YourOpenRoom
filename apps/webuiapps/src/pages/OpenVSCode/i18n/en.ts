const en = {
  eyebrow: "Aoi's IDE",
  title: "Aoi's IDE",
  loading: 'Loading workspace…',
  actions: {
    settings: 'Workspace',
    refresh: 'Refresh',
    refreshing: 'Refreshing…',
    save: 'Save file',
    saving: 'Saving…',
    saveWorkspace: 'Save workspace path',
  },
  settings: {
    title: 'Workspace path',
    description:
      'Choose which local folder this lightweight IDE should read and edit inside OpenRoom.',
    workspacePath: 'Workspace path',
    workspacePlaceholder: 'Defaults to the current OpenRoom project root',
  },
  sidebar: {
    files: 'Files',
    ready: 'Ready',
    notReady: 'Missing',
  },
  editor: {
    saved: 'Saved',
    unsaved: 'Unsaved changes',
    loading: 'Opening file…',
    discardConfirm: 'Discard your unsaved changes and open another file?',
    stats: '{{lines}} lines · {{chars}} chars',
  },
  empty: {
    title: 'Pick a file from the sidebar',
    description:
      'This built-in IDE is meant for quick edits, inspections, and saves without leaving OpenRoom.',
  },
  errors: {
    workspaceMissing:
      'The configured workspace folder could not be found. Update the workspace path and refresh.',
  },
};

export default en;
