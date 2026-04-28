const ko = {
  eyebrow: "Aoi's IDE",
  title: "Aoi's IDE",
  loading: '워크스페이스를 불러오는 중…',
  actions: {
    settings: '워크스페이스',
    newFile: '새 파일',
    createFile: '파일 생성',
    creating: '생성 중…',
    cancel: '취소',
    refresh: '새로고침',
    refreshing: '새로고침 중…',
    save: '파일 저장',
    saving: '저장 중…',
    saveWorkspace: '워크스페이스 경로 저장',
  },
  settings: {
    title: '워크스페이스 경로',
    description: 'OpenRoom 안에서 이 가벼운 IDE가 읽고 편집할 로컬 폴더를 고릅니다.',
    workspacePath: '워크스페이스 경로',
    workspacePlaceholder: '기본값은 현재 OpenRoom 프로젝트 루트입니다',
  },
  sidebar: {
    files: '파일',
    ready: '준비됨',
    notReady: '없음',
  },
  createFile: {
    label: '상대 파일 경로',
    placeholder: 'src/new-file.ts',
  },
  editor: {
    saved: '저장됨',
    unsaved: '저장되지 않은 변경',
    loading: '파일 여는 중…',
    discardConfirm: '저장하지 않은 변경을 버리고 다른 파일을 열까요?',
    stats: '{{lines}}줄 · {{chars}}자',
  },
  empty: {
    title: '왼쪽에서 파일을 선택하세요',
    description:
      '이 내장 IDE는 OpenRoom 안에서 빠르게 파일을 보고, 고치고, 저장하기 위한 도구입니다.',
  },
  errors: {
    invalidFilePath: '워크스페이스 안의 상대 파일 경로를 입력하세요.',
    workspaceMissing: '설정된 워크스페이스 폴더를 찾을 수 없습니다. 경로를 바꾼 뒤 새로고침하세요.',
  },
};

export default ko;
