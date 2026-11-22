export function wallNotificationFor(task){
 const b=task.booking;
 const title=task.kind==='cancelled'?'Booking wall: cancellation':task.kind==='changed'?'Booking wall: update changed stay':'Reminder: update booking wall';
 return {title,kind:'wall',booking_id:b.id,tag:`chakoram-wall-${b.id}`,
  body:`${b.guest_name} · ${b.reference} · ${b.room_ids.join(', ')} · ${b.check_in} to ${b.check_out}. ${task.kind==='cancelled'?'Remove this cancelled booking from the tile wall.':task.kind==='review'?'Review this reservation before writing it on the tile wall.':'Write the latest booking details on the tile wall.'} Mark “Booking wall updated” when done.`};
}
