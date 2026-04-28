const ko = {
  kicker: '로컬 갤러리',
  title: 'Album',
  subtitle: '로컬 사진 폴더를 빠르게 고르고, 검색하고, 큰 화면으로 감상할 수 있는 갤러리입니다.',
  galleryLabel: '사진 갤러리',
  back: '뒤로',
  prev: '이전',
  next: '다음',
  actions: {
    pickFolder: '폴더 선택',
    refresh: '새로고침',
    refreshing: '새로고침 중',
    savePath: '경로 저장',
    saving: '저장 중',
    clear: '지우기',
  },
  source: {
    configuredFolder: '설정에 저장된 폴더',
    sessionFolder: '이번 세션에서 선택한 폴더',
    noFolder: '저장된 폴더 없음',
    pickedFolder: '선택한 폴더',
    rootFolder: '루트',
    folderLabelFallback: '사진 소스',
  },
  fields: {
    photoDirectory: '저장할 로컬 폴더',
    photoDirectoryPlaceholder: '재실행 후에도 쓰려면 절대 폴더 경로를 붙여넣으세요',
    search: '사진, 폴더, 파일명 검색',
    thumbSize: '썸네일 크기',
  },
  stats: {
    photos: '사진',
    folders: '폴더',
    latest: '최근',
    size: '용량',
  },
  sort: {
    newest: '최신순',
    oldest: '오래된순',
    name: '이름순',
    folder: '폴더순',
  },
  empty: {
    notConfiguredTitle: '폴더를 선택해 시작하세요',
    notConfiguredCopy:
      '이번 세션에서 바로 볼 폴더를 선택하거나, 로컬 경로를 저장해 다음 실행 때도 같은 폴더를 열 수 있습니다.',
    folderMissingTitle: '저장된 폴더를 찾을 수 없습니다',
    folderMissingCopy:
      '설정된 사진 폴더가 없거나 접근할 수 없습니다. 다른 폴더를 선택하거나 저장 경로를 수정하세요.',
    noImagesTitle: '이미지를 찾지 못했습니다',
    noImagesCopy: '선택한 폴더를 훑었지만 지원되는 이미지 파일이 없습니다.',
    noResultsTitle: '검색 결과가 없습니다',
    noResultsCopy: '다른 파일명, 날짜, 폴더 이름으로 다시 검색해 보세요.',
  },
  info: {
    date: '날짜',
    folder: '폴더',
    size: '파일 크기',
  },
};

export default ko;
