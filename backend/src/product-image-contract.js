import { bool, integer, object, uuid } from './http.js';

export const productImagePlanPath = '/v1/media/images/product-plans';
export const imagePlanRetryUrl = (planId, position) => productImagePlanPath + '/' + planId + '/images/' + position + '/retry';
export const assetDeliveryUrl = assetId => '/v1/assets/' + assetId + '/delivery';
export const imageDeliveryFields = {
  assetId:{type:['string','null'],format:'uuid'}, aiGenerated:bool, deliveryUrl:{type:['string','null']},
};

export function imageDelivery(assetId) {
  return {assetId, aiGenerated:assetId !== null, deliveryUrl:assetId ? assetDeliveryUrl(assetId) : null};
}

export const imagePlanTask = object({
  planId:uuid, position:integer(0,7), attempt:integer(1,2147483647), latest:bool, canRetry:bool,
  retryUrl:{type:['string','null']}, ...imageDeliveryFields,
});
