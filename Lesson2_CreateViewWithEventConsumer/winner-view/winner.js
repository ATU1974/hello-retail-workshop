'use strict'

const AJV = require('ajv')
const aws = require('aws-sdk') // eslint-disable-line import/no-unresolved, import/no-extraneous-dependencies

// TODO Get these from a better place later
const eventSchema = require('./retail-stream-schema-egress.json')
const productCreateSchema = require('./product-create-schema.json')
const productImageSchema = require('./product-image-schema.json')
const productPurchaseSchema = require('./product-purchase-schema.json')

// TODO generalize this?  it is used by but not specific to this module
const makeSchemaId = schema => `${schema.self.vendor}/${schema.self.name}/${schema.self.version}`

const eventSchemaId = makeSchemaId(eventSchema)
const productCreateSchemaId = makeSchemaId(productCreateSchema)
const productImageSchemaId = makeSchemaId(productImageSchema)
const productPurchaseSchemaId = makeSchemaId(productPurchaseSchema)

const ajv = new AJV()
ajv.addSchema(eventSchema, eventSchemaId)
ajv.addSchema(productCreateSchema, productCreateSchemaId)
ajv.addSchema(productImageSchema, productImageSchemaId)
ajv.addSchema(productPurchaseSchema, productPurchaseSchemaId)

const dynamo = new aws.DynamoDB.DocumentClient()

const constants = {
  // self
  MODULE: 'winner-view/winner.js',
  // methods
  METHOD_REGISTER_CONTRIBUTOR: 'registerContributor',
  METHOD_UPDATE_SCORES_TABLES: 'updateScoresTable',
  METHOD_GET_EVENTS_THEN_CREDIT: 'getEventsThenCredit',
  METHOD_PROCESS_EVENT: 'processEvent',
  METHOD_PROCESS_KINESIS_EVENT: 'processKinesisEvent',
  METHOD_CREDIT_CONTRIBUTIONS: 'creditContributions',
  METHOD_UPDATE_PURCHASE_EVENT: 'updatePurchaseEvent',
  // errors
  BAD_MSG: 'bad msg:',
  // resources
  TABLE_CONTRIBUTIONS_NAME: process.env.TABLE_CONTRIBUTIONS_NAME,
  TABLE_SCORES_NAME: process.env.TABLE_SCORES_NAME,
  TABLE_EVENTS_NAME: process.env.TABLE_EVENTS_NAME,
}

const impl = {
  /**
   * Register creator or photographer to contributions tables.  Example event (for creator):
   * {
   *   "schema": "com.nordstrom/retail-stream-egress/1-0-0",
   *   "origin": "hello-retail/product-producer-creator/uniqueId/friendlyName",
   *   "timeOrigin": "2017-03-28T23:29:23.160Z",
   *   "data": {
   *     "schema": "com.nordstrom/product/create/1-0-0",
   *     "id": "4579874",
   *     "brand": "POLO RALPH LAUREN",
   *     "name": "Polo Ralph Lauren 3-Pack Socks",
   *     "description": "PAGE:/s/polo-ralph-lauren-3-pack-socks/4579874",
   *     "category": "Socks for Men"
   *   },
   *   "eventId":"shardId-000000000002:49571669009522853278119462494300940056686602130905104418",
   *   "timeIngest":"2017-03-28T23:29:23.262Z",
   *   "timeProcess":"2017-03-28T23:29:29.720Z"
   * }
   * @param role Either photographer or creator role
   * @param event Either a product/create or a product/image event.
   * @param complete The callback to inform of completion, with optional error parameter.
   */
  registerContributor: (role, event, complete) => {
    const updated = Date.now()

    const updateCallback = (err) => {
      if (err) {
        complete(`${constants.METHOD_REGISTER_CONTRIBUTOR} - errors updating DynamoDb: ${err}`)
      } else {
        const roleInfo = {}
        roleInfo[role] = event.origin
        impl.getEventsThenCredit(event.data.id, event.eventId, event.origin, roleInfo, complete)
      }
    }

    // Record product's contributor registration
    const expression = [
      'set',
      '#c=if_not_exists(#c,:c),',
      '#cb=if_not_exists(#cb,:cb),',
      '#u=:u,',
      '#ub=:ub,',
      '#ro=if_not_exists(#ro,:ro),',
      '#ev=if_not_exists(#ev,:ev)',
    ]
    const attNames = {
      '#c': 'created',
      '#cb': 'createdBy',
      '#u': 'updated',
      '#ub': 'updatedBy',
      '#ro': role,
      '#ev': `${role}EventId`,
    }
    const attValues = {
      ':c': updated,
      ':cb': event.origin,
      ':u': updated,
      ':ub': event.origin,
      ':ro': event.origin,
      ':ev': event.eventId,
    }

    const dbParamsContributions = {
      TableName: constants.TABLE_CONTRIBUTIONS_NAME,
      Key: {
        productId: event.data.id,
      },
      UpdateExpression: expression.join(' '),
      ExpressionAttributeNames: attNames,
      ExpressionAttributeValues: attValues,
      ReturnValues: 'NONE',
      ReturnConsumedCapacity: 'NONE',
      ReturnItemCollectionMetrics: 'NONE',
    }
    dynamo.update(dbParamsContributions, updateCallback)
  },
  /**
   * Get events from the Events table that will need to have the contributor attached to them.
   * @param id The product id
   * @param origin Who/what triggered this update
   * @param roleInfo Who was the hotographer or creator for this product
   * @param baseline The eventId that first registered the contributor, so credit is only applied subsequently.
   * @param complete The callback to inform of completion, with optional error parameter.
   */
  getEventsThenCredit: (id, baseline, origin, roleInfo, complete) => {
    const params = {
      TableName: constants.TABLE_EVENTS_NAME,
      ProjectionExpression: '#e',
      KeyConditionExpression: '#i = :i AND #e > :e',
      ExpressionAttributeNames: {
        '#i': 'productId',
        '#e': 'eventId',
      },
      ExpressionAttributeValues: {
        ':i': id,
        ':e': baseline,
      },
    }

    dynamo.query(params, (err, data) => {
      if (err) {
        complete(`${constants.METHOD_GET_EVENTS_THEN_CREDIT} - errors updating DynamoDb: ${err}`)
      } else if (!data || !data.Items) {
        console.log(`Found no prior events for ${id} before ${baseline}.`) // TODO remove
        complete()
      } else {
        console.log('Found prior events ', data.Items) // TODO remove
        impl.creditContributions(id, data.Items.map(item => item.eventId), origin, roleInfo, complete)
      }
    })
  },
  /**
   * Assign credit to a product-event pair in the Events table, either because of a purchase event or to true up any
   * events we may have seen prior to the registration due to the batch being out of order.  If there is no one to
   * credit, just log the product-event id.
   * @param id The product id
   * @param origin Who/what triggered this update
   * @param roleInfo Who was the photographer or creator for this product
   * @param eventIds Array of event ids for that product needing credit entered into the Events table. Note that there
   * is either both a photographer and a creator, in which case eventIds is length 1 or it is a bunch of events for a
   * single registration of either a creator or a photographer (but not both).  Expect one or small size generally.
   * Credit should only be assigned if the contributor registered prior to the purchase event, as reflected by the fact
   * the event Id is further along in the sequence for that product than the registration event; the eventIds should
   * reflect this.
   * @param complete The callback to inform of completion, with optional error parameter.
   */
  creditContributions: (id, eventIds, origin, roleInfo, complete) => {
    const updated = Date.now()

    // Record contributor info for specific event.
    const expression = [
      'set',
      '#c=if_not_exists(#c,:c),',
      '#cb=if_not_exists(#cb,:cb),',
      '#u=:u,',
      '#ub=:ub',
    ]
    const attNames = {
      '#c': 'created',
      '#cb': 'createdBy',
      '#u': 'updated',
      '#ub': 'updatedBy',
    }
    const attValues = {
      ':c': updated,
      ':cb': origin,
      ':u': updated,
      ':ub': origin,
    }

    if (roleInfo) {
      if (roleInfo.creator) {
        expression.push(', #cr=:cr')
        attNames['#cr'] = 'creator'
        attValues[':cr'] = roleInfo.creator
      }
      if (roleInfo.photographer) {
        expression.push(', #ph=:ph')
        attNames['#ph'] = 'photographer'
        attValues[':ph'] = roleInfo.photographer
      }
    } else {
      console.log(`${constants.METHOD_CREDIT_CONTRIBUTIONS} No contributors passed, so just logging event.`) // TODO remove
    }

    let successes = 0
    const groupDynamoCallback = (err) => {
      if (err) {
        complete(`${constants.METHOD_CREDIT_CONTRIBUTIONS} - errors updating DynamoDb: ${err}`)
      } else {
        successes += 1
      }
      if (successes === eventIds.length) {
        console.log(`${constants.MODULE} ${constants.METHOD_CREDIT_CONTRIBUTIONS} - all ${eventIds.length} events updated successfully for ${id}.`)
        impl.updateScoresTable(origin, roleInfo, complete)
      }
    }
    for (let i = 0; i < eventIds.length; i++) {
      const dbParamsEvents = {
        TableName: constants.TABLE_EVENTS_NAME,
        Key: {
          productId: id,
          eventId: eventIds[i],
        },
        UpdateExpression: expression.join(' '),
        ExpressionAttributeNames: attNames,
        ExpressionAttributeValues: attValues,
        ReturnValues: 'NONE',
        ReturnConsumedCapacity: 'NONE',
        ReturnItemCollectionMetrics: 'NONE',
      }
      dynamo.update(dbParamsEvents, groupDynamoCallback)
    }
  },
  /**
   * Update scores table on whatever contributor(s) were just affected.
   * @param data Who to update that was affected by last update of creator and/or photographer.
   * @param origin Who/what generated the activity leading to this update
   * @param complete The callback to inform of completion, with optional error parameter.
   */
  updateScoresTable: (origin, data, complete) => {
    const updated = Date.now()

    let priorErr
    const updateCallback = (err) => {
      if (priorErr === undefined) { // first update result
        if (err) {
          priorErr = err
        } else {
          priorErr = false
        }
      } else if (priorErr && err) { // second update result, if an error was previously received and we have a new one
        complete(`${constants.METHOD_UPDATE_SCORES_TABLES} - errors updating DynamoDb: ${[priorErr, err]}`)
      } else if (priorErr || err) {
        complete(`${constants.METHOD_UPDATE_SCORES_TABLES} - error updating DynamoDb: ${priorErr || err}`)
      } else { // second update result if error was not previously seen.
        complete()
      }
    }
    if (!data || (!data.creator && !data.photographer)) {
      console.log('No contributor information on that update, so no effect on scores.')
      // TODO could log this to an UNKNOWN contributor for both
      complete()
    } else {
      const updateExp = [
        'set',
        '#u=:u,',
        '#ub=:ub,',
        '#sc=:sc',
      ].join(' ')
      const attNames = {
        '#u': 'updated',
        '#ub': 'updatedBy',
        '#sc': 'score',
      }
      const attValues = {
        ':u': updated,
        ':ub': origin,
      }
      if (data.creator) {
        const params = {
          TableName: constants.TABLE_EVENTS_NAME,
          IndexName: 'EventsByCreator',
          ProjectionExpression: '#i, #e', // TODO remove after removing console.log
          KeyConditionExpression: '#cr = :cr',
          ExpressionAttributeNames: {
            '#i': 'productId', // TODO remove after removing console.log
            '#e': 'eventId', // TODO remove after removing console.log
            '#cr': 'creator',
          },
          ExpressionAttributeValues: {
            ':cr': data.creator,
          },
        }

        dynamo.query(params, (err, response) => {
          if (err) { // error from dynamo
            updateCallback(`${constants.METHOD_UPDATE_SCORES_TABLES} - errors getting records from GSI Creator DynamoDb: ${err}`)
          } else {
            console.log('Found pairs ', response.Items) // TODO remove
            const attValuesCreator = Object.assign({}, attValues)
            attValuesCreator[':sc'] = response.Count
            const dbParamsCreator = {
              TableName: constants.TABLE_SCORES_NAME,
              Key: {
                userId: data.creator,
                role: 'creator',
              },
              UpdateExpression: updateExp,
              ExpressionAttributeNames: attNames,
              ExpressionAttributeValues: attValuesCreator,
              ReturnValues: 'NONE',
              ReturnConsumedCapacity: 'NONE',
              ReturnItemCollectionMetrics: 'NONE',
            }
            dynamo.update(dbParamsCreator, updateCallback)
          }
        })
      } else { // TODO could log this to an UNKNOWN contributor instead
        updateCallback()
      }
      if (data.photographer) {
        const params = {
          TableName: constants.TABLE_EVENTS_NAME,
          IndexName: 'EventsByPhotographer',
          ProjectionExpression: '#i, #e', // TODO remove after removing console.log
          KeyConditionExpression: '#ph = :ph',
          ExpressionAttributeNames: {
            '#i': 'productId', // TODO remove after removing console.log
            '#e': 'eventId', // TODO remove after removing console.log
            '#ph': 'photographer',
          },
          ExpressionAttributeValues: {
            ':ph': data.photographer,
          },
        }

        dynamo.query(params, (err, response) => {
          if (err) { // error from dynamo
            updateCallback(`${constants.METHOD_UPDATE_SCORES_TABLES} - errors getting records from GSI Photographer DynamoDb: ${err}`)
          } else {
            console.log('Found pairs ', response.Items) // TODO remove
            const attValuesPhotographer = Object.assign({}, attValues)
            attValuesPhotographer[':sc'] = response.Count
            const dbParamsPhotographer = {
              TableName: constants.TABLE_SCORES_NAME,
              Key: {
                userId: data.photographer,
                role: 'photographer',
              },
              UpdateExpression: updateExp,
              ExpressionAttributeNames: attNames,
              ExpressionAttributeValues: attValuesPhotographer,
              ReturnValues: 'NONE',
              ReturnConsumedCapacity: 'NONE',
              ReturnItemCollectionMetrics: 'NONE',
            }
            dynamo.update(dbParamsPhotographer, updateCallback)
          }
        })
      } else { // TODO could log this to an UNKNOWN contributor instead
        updateCallback()
      }
    }
  },
  /**
   * Log latest purchase of a given product id to the Events table.  Example event:
   * {
   *   "schema":"com.nordstrom/retail-stream-egress/1-0-0",
   *   "timeOrigin":"2017-03-28T23:52:53.763Z",
   *   "data":{
   *      "schema":"com.nordstrom/product/purchase/1-0-0",
   *      "id":"7749361"
   *   },
   *   "origin":"hello-retail/web-client-purchase-product/uniqueId/friendlyName",
   *   "eventId":"shardId-000000000001:49571669109051079099161633575187621651768511161306185746",
   *   "timeIngest":"2017-03-28T23:52:53.818Z",
   *   "timeProcess":"2017-03-28T23:52:59.677Z"
   * },
   * @param event The event that is currently being processed.
   * @param complete The callback to inform of completion, with optional error parameter.
   */
  updatePurchaseEvent: (event, complete) => {
    const dbParamsContributions = {
      Key: {
        productId: event.data.id,
      },
      TableName: constants.TABLE_CONTRIBUTIONS_NAME,
      AttributesToGet: [
        'creator',
        'creatorEventId',
        'photographer',
        'photographerEventId',
      ],
      ConsistentRead: false,
      ReturnConsumedCapacity: 'NONE',
    }
    dynamo.get(dbParamsContributions, (err, data) => {
      if (err) {
        complete(`${constants.METHOD_UPDATE_PURCHASE_EVENT} - errors getting product ${event.data.id} from DynamoDb table ${constants.TABLE_CONTRIBUTIONS_NAME}: ${err}`)
      } else {
        const roleInfo = {}
        if (data && data.Item) {
          if (data.Item.creator && data.Item.creatorEventId && event.eventId > data.Item.creatorEventId) {
            roleInfo.creator = data.Item.creator
          }
          if (data.Item.photographer && data.Item.photographerEventId && event.eventId > data.Item.photographerEventId) {
            roleInfo.photographer = data.Item.photographer
          }
        }
        impl.creditContributions(event.data.id, [event.eventId], event.origin, roleInfo, complete)
      }
    })
  },
  /**
   * Process the given event, reporting failure or success to the given callback
   * @param event The event to validate and process with the appropriate logic
   * @param complete The callback with which to report any errors
   */
  processEvent: (event, complete) => {
    if (!event || !event.schema) {
      complete(`${constants.METHOD_PROCESS_EVENT} ${constants.BAD_MSG} event or schema was not truthy.`)
    } else if (event.schema !== eventSchemaId) {
      complete(`${constants.METHOD_PROCESS_EVENT} ${constants.BAD_MSG} event did not have proper schema.  observed: '${event.schema}' expected: '${eventSchemaId}'`)
    } else if (!ajv.validate(eventSchemaId, event)) {
      complete(`${constants.METHOD_PROCESS_EVENT} ${constants.BAD_MSG} could not validate event to '${eventSchemaId}' schema.  Errors: ${ajv.errorsText()}`)
    } else if (event.data.schema === productCreateSchemaId) {
      if (!ajv.validate(productCreateSchemaId, event.data)) {
        complete(`${constants.METHOD_PROCESS_EVENT} ${constants.BAD_MSG} could not validate event to '${productCreateSchemaId}' schema. Errors: ${ajv.errorsText()}`)
      } else {
        impl.registerContributor('creator', event, complete)
      }
    } else if (event.data.schema === productImageSchemaId) {
      if (!ajv.validate(productImageSchemaId, event.data)) {
        complete(`${constants.METHOD_PROCESS_EVENT} ${constants.BAD_MSG} could not validate event to '${productImageSchemaId}' schema. Errors: ${ajv.errorsText()}`)
      } else {
        impl.registerContributor('photographer', event, complete)
      }
    } else if (event.data.schema === productPurchaseSchemaId) {
      if (!ajv.validate(productPurchaseSchemaId, event.data)) {
        complete(`${constants.METHOD_PROCESS_EVENT} ${constants.BAD_MSG} could not validate event to '${productPurchaseSchemaId}' schema. Errors: ${ajv.errorsText()}`)
      } else {
        impl.updatePurchaseEvent(event, complete)
      }
    } else {
      // TODO remove console.log and pass the above message once we are only receiving subscribed events
      console.log(`${constants.MODULE} ${constants.METHOD_PROCESS_EVENT} ${constants.BAD_MSG} - event with unsupported schema (${event.data.schema}) observed.`)
      complete()
    }
  },
}

// TODO separate out kinesis-consuming code into a module

module.exports = {
  /**
   * Example Kinesis Event:
   * {
   *   "Records": [
   *     {
   *       "kinesis": {
   *         "kinesisSchemaVersion": "1.0",
   *         "partitionKey": "undefined",
   *         "sequenceNumber": "49568749374218235080373793662003016116473266703358230578",
   *         "data": "eyJzY2hlbWEiOiJjb20ubm9yZHN0cm9tL3JldGFpb[...]Y3NDQiLCJjYXRlZ29yeSI6IlN3ZWF0ZXJzIGZvciBNZW4ifX0=",
   *         "approximateArrivalTimestamp": 1484245766.362
   *       },
   *       "eventSource": "aws:kinesis",
   *       "eventVersion": "1.0",
   *       "eventID": "shardId-000000000003:49568749374218235080373793662003016116473266703358230578",
   *       "eventName": "aws:kinesis:record",
   *       "invokeIdentityArn": "arn:aws:iam::515126931066:role/devProductCatalogReaderWriter",
   *       "awsRegion": "us-west-2",
   *       "eventSourceARN": "arn:aws:kinesis:us-west-2:515126931066:stream/devRetailStream"
   *     },
   *     {
   *       "kinesis": {
   *         "kinesisSchemaVersion": "1.0",
   *         "partitionKey": "undefined",
   *         "sequenceNumber": "49568749374218235080373793662021150003767486140978823218",
   *         "data": "eyJzY2hlbWEiOiJjb20ubm9yZHN0cm9tL3JldGFpb[...]I3MyIsImNhdGVnb3J5IjoiU3dlYXRlcnMgZm9yIE1lbiJ9fQ==",
   *         "approximateArrivalTimestamp": 1484245766.739
   *       },
   *       "eventSource": "aws:kinesis",
   *       "eventVersion": "1.0",
   *       "eventID": "shardId-000000000003:49568749374218235080373793662021150003767486140978823218",
   *       "eventName": "aws:kinesis:record",
   *       "invokeIdentityArn": "arn:aws:iam::515126931066:role/devProductCatalogReaderWriter",
   *       "awsRegion": "us-west-2",
   *       "eventSourceARN": "arn:aws:kinesis:us-west-2:515126931066:stream/devRetailStream"
   *     }
   *   ]
   * }
   * @param kinesisEvent The Kinesis event to decode and process.
   * @param context The Lambda context object.
   * @param callback The callback with which to call with results of event processing.
   */
  processKinesisEvent: (kinesisEvent, context, callback) => {
    try {
      console.log(`${constants.MODULE} ${constants.METHOD_PROCESS_KINESIS_EVENT} - kinesis event received: ${JSON.stringify(kinesisEvent, null, 2)}`)
      if (
        kinesisEvent &&
        kinesisEvent.Records &&
        Array.isArray(kinesisEvent.Records)
      ) { // TODO convert this to handle events synchronously, if needed to preserve a sequentially-ordered batch
        let successes = 0
        const complete = (err) => {
          if (err) {
            console.log(err)
            // TODO uncomment following
            // throw new Error(`${constants.MODULE} ${err}`);
            // TODO remove rest of block to use above.
            const msg = `${constants.MODULE} ${err}`
            if (msg.indexOf(`${constants.MODULE} ${constants.METHOD_PROCESS_EVENT} ${constants.BAD_MSG}`) !== -1) {
              console.log('######################################################################################')
              console.log(msg)
              console.log('######################################################################################')
              successes += 1
            } else {
              throw new Error(msg)
            }
          } else {
            successes += 1
          }
          if (successes === kinesisEvent.Records.length) {
            console.log(`${constants.MODULE} ${constants.METHOD_PROCESS_KINESIS_EVENT} - all ${kinesisEvent.Records.length} events processed successfully.`)
            callback()
          }
        }
        for (let i = 0; i < kinesisEvent.Records.length; i++) {
          const record = kinesisEvent.Records[i]
          if (
            record.kinesis &&
            record.kinesis.data
          ) {
            let parsed
            try {
              const payload = new Buffer(record.kinesis.data, 'base64').toString()
              console.log(`${constants.MODULE} ${constants.METHOD_PROCESS_KINESIS_EVENT} - payload: ${payload}`)
              parsed = JSON.parse(payload)
            } catch (ex) {
              complete(`${constants.METHOD_PROCESS_EVENT} ${constants.BAD_MSG} failed to decode and parse the data - "${ex.stack}".`)
            }
            if (parsed) {
              impl.processEvent(parsed, complete)
            }
          } else {
            complete(`${constants.METHOD_PROCESS_EVENT} ${constants.BAD_MSG} record missing kinesis data.`)
          }
        }
      } else {
        callback(`${constants.MODULE} ${constants.METHOD_PROCESS_KINESIS_EVENT} - no records received.`)
      }
    } catch (ex) {
      console.log(`${constants.MODULE} ${constants.METHOD_PROCESS_KINESIS_EVENT} - exception: ${ex.stack}`)
      callback(ex)
    }
  },
}

console.log(`${constants.MODULE} - CONST: ${JSON.stringify(constants, null, 2)}`)
console.log(`${constants.MODULE} - ENV:   ${JSON.stringify(process.env, null, 2)}`)
