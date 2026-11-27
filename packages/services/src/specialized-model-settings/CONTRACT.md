# 专用模型设置服务

只在本机桌面窗口的本地附件发布。JSON 文件由 Host 在文件锁内提交，图像生成、特征提取和小工具模型各自检查自己的修订号。图像生成的密钥由 Host 凭据库保存。小工具和特征提取各自拥有一个模型标记，候选来自本机模型设置。特征模型需要支持文本及图像输入、文本输出。

owner 的 `resolveImageModel(expectedRevision)` 仅由本机装配调用：读取默认配置，核验界面看到的修订号并解析私有凭据。此方法不属于 `ISpecializedModelSettingsService`，不得经 attachment、远程/手机或通用凭据服务发布。

owner 的 `resolveFeatureModel(expectedRevision, expectedRouteKey)` 核验界面确认的修订与有效供应商路由，并从本机模型注册表核对可执行选择。附件服务投影模型选择、修订、可用状态、端点域名和不含凭据的路由指纹。CLI 用实际绑定的供应商配置重新校验指纹。
