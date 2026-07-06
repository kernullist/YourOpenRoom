# YouTube 应用数据指南

## 文件夹结构

```text
/
└── state.json
```

## 状态文件 `/state.json`

这个应用是一个带应用内播放列表的 YouTube 搜索启动器。它不维护单独的歌曲或播放列表文件，
所有数据都保存在 `state.json` 中。

| 字段                   | 类型          | 默认值           | 说明                                             |
| ---------------------- | ------------- | ---------------- | ------------------------------------------------ |
| searchQuery            | string        | `""`             | 当前搜索关键词                                   |
| recentSearches         | SearchEntry[] | `[]`             | 最近的 YouTube 搜索记录                          |
| favoriteTopics         | string[]      | 预置列表         | 已保存的一键主题                                 |
| playlists              | Playlist[]    | 一个空播放列表   | 应用内播放列表，保存收藏的视频                   |
| activePlaylistId       | string\|null  | 默认播放列表     | 当前选中（用于编辑/添加）的播放列表              |
| lastPlayedPlaylistId   | string\|null  | `null`           | 最近以队列方式播放过的播放列表                   |
| lastPlayedPlaylistMode | string\|null  | `null`           | 上次的队列模式：`"sequential"` 或 `"shuffle"`    |
| sidebarOpen            | boolean       | `false`          | 左侧已保存主题侧栏是否展开                       |
| resultsAutoHide        | boolean       | `false`          | 选中视频后是否自动收起应用内搜索结果列表         |
| loopPlayback           | boolean       | `false`          | 应用内播放器是否循环当前视频或队列               |
| playerZoom             | number        | `1`              | 应用内播放器缩放系数，`1` 表示 100%              |

### SearchEntry

| 字段      | 类型   | 说明                 |
| --------- | ------ | -------------------- |
| id        | string | 搜索记录唯一 ID      |
| query     | string | 搜索关键词文本       |
| createdAt | number | 毫秒级时间戳         |

### Playlist

| 字段      | 类型           | 说明                     |
| --------- | -------------- | ------------------------ |
| id        | string         | 播放列表唯一 ID          |
| name      | string         | 播放列表显示名称         |
| items     | PlaylistItem[] | 按顺序保存的视频         |
| createdAt | number         | 毫秒级时间戳             |
| updatedAt | number         | 最后一次修改的时间戳     |

### PlaylistItem

一条已保存的 YouTube 搜索结果。字段：`id`（YouTube 视频 id）、`title`、`channel`、`duration`、
`views`、`published`、`thumbnail`、`url`，以及 `addedAt`（毫秒级时间戳）。

## Agent 工作流

常规操作流程：

1. 阅读 `meta.yaml`
2. 阅读本指南
3. 使用 `OPEN_SEARCH` 搜索准确的歌曲、歌手或主题关键词
4. 已有具体视频链接时使用 `OPEN_VIDEO`
5. 使用 `PLAY_LAST_PLAYLIST` 恢复最近播放的播放列表队列
6. 需要时使用 `OPEN_HOME` 打开 YouTube 首页
7. 直接写入 `state.json` 后发送 `SYNC_STATE` 让应用重新加载

注意事项：

- 用户同意播放推荐歌曲时，用“歌手 + 歌名”完整关键词搜索。
- 想自动播放第一条搜索结果时，给 `OPEN_SEARCH` 传 `autoplay: "1"`。
- `OPEN_VIDEO` 默认自动播放；传 `autoplay: "0"` 时仅加载不播放。
- 已有具体 YouTube 链接时优先使用 `OPEN_VIDEO` 而不是重新搜索。
- 最近搜索、收藏主题与播放列表由应用自行维护在 `state.json` 中。

## 应用内播放器行为

- 在应用内点击搜索结果或播放列表条目会立即开始播放。
- 队列播放时点击其他队列条目会直接跳转，不会重排队列，也不会重载播放器。
- 切换循环、缩放或结果列表不会重载播放器 iframe。
- 播放弹窗只能通过关闭按钮或 Escape 键关闭。
