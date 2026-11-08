import type PicnicClient from 'picnic-api';

/** cents: de regelprijs na korting (voor het budget). */
export type HistoryLine = {productId:string; name:string; pack:string; quantity:number; cents?:number};
export type HistoryDelivery = {
  id:string; date:string; totalCents:number; savingsCents?:number; paidCents?:number;
  orders:{id:string; orderedAt:string; items:HistoryLine[]}[];
};
export type PicnicHistory = { syncedAt:string; deliveries:HistoryDelivery[] };
type DeliveryReader = Pick<InstanceType<typeof PicnicClient>['delivery'],'getDeliverySummaries'|'getDelivery'>;
const day = 86_400_000;
const localDate = new Intl.DateTimeFormat('sv-SE',{timeZone:'Europe/Amsterdam',year:'numeric',month:'2-digit',day:'2-digit'});

export async function importDeliveries(reader: DeliveryReader, now = Date.now()): Promise<PicnicHistory> {
  const summaries = await reader.getDeliverySummaries(['COMPLETED']);
  const selected = new Map<string,string>();
  for (const summary of summaries) {
    if (summary.status !== 'COMPLETED') continue;
    const date = Date.parse(summary.windowStart ?? '');
    if (!summary.id || !Number.isFinite(date)) throw new Error('Invalid completed delivery summary');
    if (date <= now && now - date <= 84 * day) selected.set(summary.id,localDate.format(date));
    if (selected.size >= 30) break;
  }
  const deliveries: HistoryDelivery[] = [];
  for (const [id,date] of selected) {
    const delivery = await reader.getDelivery(id);
    if (delivery.id !== id || delivery.status !== 'COMPLETED' || !Number.isSafeInteger(delivery.totalPrice)) {
      throw new Error('Invalid completed delivery');
    }
    const orders = delivery.orders.filter(order=>order.status !== 'CANCELLED').map(order=>{
      if (!order.id || !Number.isFinite(Date.parse(order.creationTime))) throw new Error('Invalid order');
      const items = order.items.map(item=>{
        if (!item.productId || !item.name || !Number.isSafeInteger(item.quantity) || item.quantity < 1) {
          throw new Error('Invalid delivery line');
        }
        return {productId:item.productId,name:item.name,pack:item.unitQuantity,quantity:item.quantity,...(Number.isSafeInteger(item.displayPrice) ? {cents:item.displayPrice} : {})};
      });
      return {id:order.id,orderedAt:order.creationTime,items};
    });
    const savings = (delivery.promotionSavings || 0) + (delivery.membershipSavings || 0);
    const paid = delivery.orders.filter(order=>order.status !== 'CANCELLED').reduce((sum,order)=>sum+(order.checkoutTotalPrice||0),0);
    deliveries.push({id,date,totalCents:delivery.totalPrice,paidCents:paid,...(savings > 0 ? {savingsCents:savings} : {}),orders});
  }
  return {syncedAt:new Date(now).toISOString(),deliveries:deliveries.sort((a,b)=>b.date.localeCompare(a.date))};
}
