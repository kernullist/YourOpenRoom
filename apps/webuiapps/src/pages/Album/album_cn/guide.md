# 相册 数据指南

Album 现在主要是本地照片文件夹浏览器。旧版本的应用存储图片元数据仍然可以读取，但用户主要通过 UI 选择本地文件夹，或保存一个绝对路径作为长期照片来源。

## 文件夹结构

```text
/
└── images/                # 旧版图片元数据目录
    ├── {id}.json          # 单张图片元数据
    └── ...
```

## 本地文件夹来源

Album 可以通过两种方式加载照片：

- 用户点击 **Choose folder**，在浏览器里授权当前会话访问某个目录
- 用户保存绝对文件夹路径，该路径会作为 `album.photoDirectory` 写入 `~/.openroom/config.json`

本地 Vite
middleware 会读取保存的文件夹路径，并返回支持的图片文件。前端会展示搜索、排序、网格密度、文件夹数量、最近修改时间和预览面板。

Agent 不应向用户照片文件夹写入任意文件；Album 的本地目录访问应保持图片浏览用途。

## 旧版图片目录 `/images/`

旧会话可能仍然包含 `/images/` 下的生成图片元数据。每张图片一个 JSON 文件，文件名为图片 ID。

- 前端仍可读取这些记录作为图库项目。
- 新的用户相册浏览以本地文件夹为主；若目标是切换照片来源，优先更新 `album.photoDirectory`。

### 图片文件 `{id}.json`

| 字段      | 类型    | 必填 | 说明                                               |
| --------- | ------- | ---- | -------------------------------------------------- |
| id        | string  | 是   | 图片唯一标识，与文件名一致，不含 `.json` 后缀      |
| src       | string  | 是   | 图片地址：`data:image/...` data URL 或 `https` URL |
| name      | string  | 否   | 显示文件名                                         |
| createdAt | integer | 是   | 创建时间戳，毫秒                                   |
| size      | number  | 否   | 文件大小，字节                                     |
| folder    | string  | 否   | 图库中显示的文件夹标签                             |

示例：

```json
{
  "id": "img-001",
  "src": "data:image/jpeg;base64,/9j/4AAQ...",
  "name": "portrait.jpg",
  "folder": "portraits",
  "createdAt": 1706000000000,
  "size": 245760
}
```

## 数据同步说明

### Agent 操作

如果 Agent 修改 Album 的应用存储文件，应下发 `REFRESH`
action。若目标是修改本地照片来源，应通过配置 API 更新持久化配置，而不是向 `/images/`
写入本地相册集合。

### 用户操作

用户可以选择文件夹、按文件名/文件夹/日期搜索、按 newest/oldest/name/folder 排序、调整网格密度并打开预览。浏览器文件夹选择只对当前会话有效；保存绝对路径后，Album 会在重启后重新打开该文件夹。
