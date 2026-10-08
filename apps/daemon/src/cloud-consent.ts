import { AppError, hasProjectMaterial, type ModelConfig, type Session } from '@lodex/contracts';

/** Both chat and summarization transmit historical material, including removed selections. */
export function validateCloudTransmission(session: Session, configs: ModelConfig[]): void {
  if (!configs.some((config) => config.provider === 'openrouter')) return;
  if (
    ((session.projectId && session.routing?.subagentsEnabled) || hasProjectMaterial(session)) &&
    configs.some((config) => config.provider === 'openrouter' && !config.projectCloudConsent)
  )
    throw new AppError(
      'PROJECT_CLOUD_CONSENT',
      '프로젝트 작업 결과가 전달되는 모든 OpenRouter 역할에 프로젝트 전송 동의가 필요합니다.',
      403,
    );
  if (
    !session.mcpCloudConsent &&
    (session.hasMcpHistory ||
      session.mcpAttachments?.length ||
      (session.mode !== 'plan' && session.mcp?.length))
  )
    throw new AppError(
      'MCP_CLOUD_CONSENT',
      'MCP 도구 설명과 실행 결과를 OpenRouter로 보내려면 이 대화의 MCP 전송 동의가 필요합니다. 선택을 해제해도 이전 내용은 기록에 남습니다.',
      403,
    );
  if (
    !session.skillCloudConsent &&
    (session.skills?.length ||
      session.hasSkillHistory ||
      session.messages.some((message) =>
        message.activities?.some((activity) => activity.skillRead),
      ))
  )
    throw new AppError(
      'SKILL_CLOUD_CONSENT',
      '스킬 메타데이터와 읽은 내용을 OpenRouter로 보내려면 이 대화의 스킬 전송 동의가 필요합니다. 이전에 읽은 내용도 대화 기록에 남아 있습니다.',
      403,
    );
}
