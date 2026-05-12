# 课堂汇报匿名评分系统

这是一个用于课堂汇报打分的小程序：

- 学生端匿名提交 `0-10` 整数分。
- 教师端实时查看各小组平均分。
- 支持第 `1-8` 小组。
- 教师端右下角显示当前小组最终平均分。

## 为什么不能只用 GitHub Pages

GitHub Pages 适合静态网页托管，不能运行本项目需要的 Node.js 后端。  
本系统需要接收学生提交、集中保存评分、实时推送给教师端，因此需要部署到能运行 Node.js 的平台。

推荐方式：

```text
GitHub 仓库 + Render Web Service
```

GitHub 负责存代码，Render 负责运行服务。

## 本地运行

```powershell
npm start
```

打开：

```text
http://localhost:3000/
http://localhost:3000/teacher
```

## 部署到 Render

1. 把本文件夹上传到 GitHub 仓库。
2. 打开 Render，新建 Web Service。
3. 连接这个 GitHub 仓库。
4. Render 通常会读取 `render.yaml`；也可以手动填写：
   - Build Command: `npm install`
   - Start Command: `npm start`
5. 设置环境变量：
   - `TEACHER_PIN`: 教师清空评分时使用的 PIN
6. 部署完成后：
   - 学生端：`https://你的服务地址/`
   - 教师端：`https://你的服务地址/teacher`

## 数据提醒

当前评分数据默认写入服务端的 `scores.json`。  
如果部署平台的免费实例重启后不保留本地文件，课堂正式使用前请确认数据持久化方案。
