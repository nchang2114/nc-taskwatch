export const SCHEDULE_EVENT_TYPE = 'nc-taskwatch:schedule-task'

export type ScheduleBroadcastDetail = {
  goalId: string
  goalName: string
  bucketId: string
  bucketName: string
  taskId: string
  taskName: string
}

export type ScheduleBroadcastEvent = CustomEvent<ScheduleBroadcastDetail>

export const broadcastScheduleTask = (detail: ScheduleBroadcastDetail) => {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent<ScheduleBroadcastDetail>(SCHEDULE_EVENT_TYPE, { detail }))
}
