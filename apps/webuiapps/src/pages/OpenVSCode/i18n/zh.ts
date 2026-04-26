const zh = {
  eyebrow: "Aoi's IDE",
  title: "Aoi's IDE",
  loading: '正在加载工作区…',
  actions: {
    settings: '工作区',
    refresh: '刷新',
    refreshing: '刷新中…',
    save: '保存文件',
    saving: '保存中…',
    saveWorkspace: '保存工作区路径',
  },
  settings: {
    title: '工作区路径',
    description: '选择这个轻量 IDE 在 OpenRoom 里应当读取和编辑的本地文件夹。',
    workspacePath: '工作区路径',
    workspacePlaceholder: '默认使用当前 OpenRoom 项目根目录',
  },
  sidebar: {
    files: '文件',
    ready: '就绪',
    notReady: '缺失',
  },
  editor: {
    saved: '已保存',
    unsaved: '有未保存修改',
    loading: '正在打开文件…',
    discardConfirm: '要放弃当前未保存的修改并打开其他文件吗？',
    stats: '{{lines}} 行 · {{chars}} 字符',
  },
  empty: {
    title: '先从左侧选择一个文件',
    description: '这个内置 IDE 适合在 OpenRoom 里快速查看、修改并保存项目文件。',
  },
  errors: {
    workspaceMissing: '当前配置的工作区文件夹不存在。请更新工作区路径后再刷新。',
  },
};

export default zh;
