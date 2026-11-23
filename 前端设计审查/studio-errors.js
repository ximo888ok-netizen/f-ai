const errorLabels = {
  UNAUTHENTICATED: '登录信息无效或会话已过期', FORBIDDEN: '当前账号没有这项权限',
  NOT_FOUND: '记录不存在或当前工作区无法访问', PROVIDER_NOT_CONFIGURED: '服务端尚未配置该能力',
  CAPABILITY_UNAVAILABLE: '当前没有可执行此能力的服务', PLUGIN_DISABLED: '当前工作区已停用该插件',
  FEATURE_NOT_AVAILABLE: '当前成员或版本未开放此功能', MEMBER_SUSPENDED: '你在当前企业的访问已停用',
  CONNECTION_DISABLED: '本企业已断开该服务',
  CAPABILITY_CONFIGURATION_CHANGED: '任务使用的能力契约已变更，需要按新版本重新提交',
  MODEL_NOT_SUPPORTED: '所选模型不支持此能力', CONSENT_REQUIRED: '素材需要有效的授权记录',
  MODEL_STREAM_UNAVAILABLE: '所选模型未启用流式回复', TASK_STREAM_BUSY: '实时回复连接繁忙，请稍候',
  MODEL_RESPONSE_INCOMPLETE: '模型回复中断，未能完成任务', MODEL_CONTENT_BLOCKED: '模型未能返回这条回复',
  VOICE_MODEL_UNAVAILABLE: '请选择已配置的转写、对话和语音合成模型',
  VOICE_TURN_TIMEOUT: '语音任务超时，请用更短的录音重试',
  SHOP_AUTH_EXPIRED:'店铺授权已到期，请重新授权后再试',
  INSUFFICIENT_CREDITS: '可用积分不足', RATE_LIMITED: '请求过于频繁，请稍后再试',
  DRAFT_CHANGED: '草稿已被更新，请先复制需要保留的修改，然后重新打开草稿',
  ASSET_IN_DRAFT: '这张图片正被商品草稿使用，请先在草稿中替换或移除',
  EMAIL_IN_USE: '该邮箱已注册', DATABASE_UNAVAILABLE: '服务端数据库暂未就绪',
};
Object.assign(errorLabels, {
  AI_VIDEO_REQUIRED:'请选择已归档的 AI 视频任务结果。',
  VIDEO_EXPORT_INVALID:'请使用可读取的 MP4。时长最多 60 秒，每边最多 1920 像素，总像素不超过 1080p，帧率最多 60。',
  VIDEO_EXPORT_MP4_REQUIRED:'请选择 MP4 视频。',
  VIDEO_EXPORT_UNAVAILABLE:'当前部署的视频导出工具不可用。',
  VIDEO_EXPORT_BUSY:'有视频正在导出，请稍后重试。',
  VIDEO_EXPORT_TIMEOUT:'视频处理超时，请缩短素材后重试。',
  VIDEO_NO_AUDIO:'这段视频没有可导出的音轨。',
  VIDEO_FRAME_OUT_OF_RANGE:'抽帧时间超出视频时长。',
  STORYBOARD_CHANGED:'分镜版本已变化，请重新打开后保存或导出。',
  STORYBOARD_ASSET_LIMIT:'分镜使用的素材合计超过 24 MiB。',
  IMAGE_BATCH_LIMIT:'此批次的素材合计超过 24 MiB。',
  IMAGE_RENDER_BUSY:'图片服务正在处理其他请求，请稍后重试。',
  IMAGE_RENDER_TIMEOUT:'图片处理超时，请减少素材或缩小尺寸后重试。',
  IMAGE_RENDER_FAILED:'图片处理服务未完成本次处理。',
  LIBRARY_CONFLICT:'技能有更新或仍被其他条目引用，请检查当前记录。',
  LIBRARY_DISABLED:'这个技能已停用。',
  COPY_RULES_CHANGED:'规则版本已变化，请重新打开当前平台的规则。',
  RIGHTS_NOTICE_CONFLICT:'案件已更新或当前阶段不能执行该操作，请重新打开案件。',
});

export function describeError(error) {
  return (errorLabels[error.code] || error.message || '操作失败') + (error.requestId ? '（请求 ' + error.requestId + '）' : '');
}
