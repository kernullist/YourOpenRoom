# YouTube 应用数据指南

## 文件夹结构

```text
/
└── state.json
```

## 状态文件 `/state.json`

这个应用是一个带应用内播放列表的 YouTube 搜索启动器。它不维护单独的歌曲或播放列表文件，所有数据都保存在
`state.json` 中。

| 字段                   | 类型             | 默认值         | 说明                                              |
| ---------------------- | ---------------- | -------------- | ------------------------------------------------- |
| searchQuery            | string           | `""`           | 当前搜索关键词                                    |
| recentSearches         | SearchEntry[]    | `[]`           | 最近的 YouTube 搜索记录                           |
| favoriteTopics         | string[]         | 预置列表       | 已保存的一键主题                                  |
| playlists              | Playlist[]       | 一个空播放列表 | 应用内播放列表，保存收藏的视频                    |
| activePlaylistId       | string\|null     | 默认播放列表   | 当前选中（用于编辑/添加）的播放列表               |
| lastPlayedPlaylistId   | string\|null     | `null`         | 最近以队列方式播放过的播放列表                    |
| lastPlayedPlaylistMode | string\|null     | `null`         | 上次的队列模式：`"sequential"` 或 `"shuffle"`     |
| sidebarOpen            | boolean          | `false`        | 左侧已保存主题侧栏是否展开                        |
| resultsAutoHide        | boolean          | `false`        | 选中视频后是否自动收起应用内搜索结果列表          |
| loopPlayback           | boolean          | `false`        | 应用内播放器是否循环当前视频或队列                |
| playerZoom             | number           | `1`            | 应用内播放器缩放系数，`1` 表示 100%               |
| nowPlaying             | NowPlaying\|null | `null`         | 应用内播放器当前加载视频的快照；无播放时为 `null` |

### SearchEntry

| 字段      | 类型   | 说明            |
| --------- | ------ | --------------- |
| id        | string | 搜索记录唯一 ID |
| query     | string | 搜索关键词文本  |
| createdAt | number | 毫秒级时间戳    |

### Playlist

| 字段      | 类型           | 说明                 |
| --------- | -------------- | -------------------- |
| id        | string         | 播放列表唯一 ID      |
| name      | string         | 播放列表显示名称     |
| items     | PlaylistItem[] | 按顺序保存的视频     |
| createdAt | number         | 毫秒级时间戳         |
| updatedAt | number         | 最后一次修改的时间戳 |

### PlaylistItem

一条已保存的 YouTube 搜索结果。字段：`id`（YouTube 视频 id）、`title`、`channel`、`duration`、
`views`、`published`、`thumbnail`、`url`，以及 `addedAt`（毫秒级时间戳）。

### NowPlaying

应用内播放器当前加载的视频。应用在每次播放变化（包括队列自动切歌）时重写该字段，关闭播放弹窗时清空为
`null`。该字段由应用独占维护：Agent 写入的值会被实时播放状态覆盖，应视为只读。用 `updatedAt`
判断新鲜度；时间戳过旧说明应用在播放中途退出，该声明不可当作实时状态。

| 字段      | 类型         | 说明                                        |
| --------- | ------------ | ------------------------------------------- |
| videoId   | string       | 播放器中当前视频的 YouTube 视频 id          |
| title     | string       | 播放器标题栏显示的视频标题                  |
| channel   | string       | 当前视频的频道名                            |
| queueName | string\|null | 队列播放时的播放列表名称，单曲播放为 `null` |
| startedAt | number       | 该视频开始播放的毫秒级时间戳                |
| updatedAt | number       | 播放状态最后一次刷新的毫秒级时间戳          |

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
- 用户拒绝某个推荐（"X 말고 Y"）时，把被拒绝的关键词以换行分隔传给 `OPEN_SEARCH` 的
  `exclude`：它们会作为减号运算符参与搜索，且命中的结果会被过滤，被拒绝的内容不会再次播放。
- `OPEN_VIDEO` 默认自动播放；传 `autoplay: "0"` 时仅加载不播放。
- 已有具体 YouTube 链接时优先使用 `OPEN_VIDEO` 而不是重新搜索。
- 最近搜索、收藏主题与播放列表由应用自行维护在 `state.json` 中。

## 应用内播放器行为

- 在应用内点击搜索结果或播放列表条目会立即开始播放。
- 队列播放时点击其他队列条目会直接跳转，不会重排队列，也不会重载播放器。
- 切换循环、缩放或结果列表不会重载播放器 iframe。
- 播放弹窗只能通过关闭按钮或 Escape 键关闭。
