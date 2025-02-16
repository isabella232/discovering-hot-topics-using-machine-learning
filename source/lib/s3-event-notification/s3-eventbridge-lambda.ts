#!/usr/bin/env node
/**********************************************************************************************************************
 *  Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.                                                *
 *                                                                                                                    *
 *  Licensed under the Apache License, Version 2.0 (the "License"). You may not use this file except in compliance    *
 *  with the License. A copy of the License is located at                                                             *
 *                                                                                                                    *
 *      http://www.apache.org/licenses/LICENSE-2.0                                                                    *
 *                                                                                                                    *
 *  or in the 'license' file accompanying this file. This file is distributed on an 'AS IS' BASIS, WITHOUT WARRANTIES *
 *  OR CONDITIONS OF ANY KIND, express or implied. See the License for the specific language governing permissions    *
 *  and limitations under the License.                                                                                *
 *********************************************************************************************************************/

import { Construct, Duration } from '@aws-cdk/core';
import * as cloudtrail from '@aws-cdk/aws-cloudtrail';
import * as events from '@aws-cdk/aws-events';
import * as targets from '@aws-cdk/aws-events-targets';
import * as iam from '@aws-cdk/aws-iam';
import * as lambda from '@aws-cdk/aws-lambda';
import * as s3 from '@aws-cdk/aws-s3';
import * as sqs from '@aws-cdk/aws-sqs';
import * as defaults from '@aws-solutions-constructs/core';

export interface S3ToEventBridgeToLambdaProps {
    /**
     * Existing instance of S3 Bucket object, providing both this and `bucketProps` will cause an error.
     *
     * @default - None
     */
    readonly existingBucketObj?: s3.IBucket;
    /**
     * Optional user provided props to override the default props for the S3 Bucket.
     *
     * @default - Default props are used
     */
    readonly bucketProps?: s3.BucketProps;
    /**
     * Existing instance of Lambda Function object, providing both this and `lambdaFunctionProps` will cause an error.
     *
     * @default - None
     */
    readonly existingLambdaObj?: lambda.Function;
    /**
     * User provided props to override the default props for the Lambda function.
     *
     * @default - Default props are used
     */
    readonly lambdaFunctionProps?: lambda.FunctionProps;
    /**
     * Optional user provided eventRuleProps to override the defaults
     *
     * @default - None
     */
    readonly eventRuleProps?: events.RuleProps;
    /**
     * Optional user provided props to override the default props for the S3 Logging Bucket.
     *
     * @default - Default props are used
     */
    readonly s3LoggingBucket?: s3.IBucket;
}

export class S3ToEventBridgeToLambda extends Construct {
    public readonly s3Bucket: s3.Bucket;
    public readonly cloudTrailBucket?: s3.IBucket;
    public readonly s3LoggingBucket?: s3.IBucket;
    public readonly lambdaFunction: lambda.Function;
    public readonly eventsRule: events.Rule;
    public readonly cloudTrail: cloudtrail.Trail;

    /**
     * Construct the new instance of S3ToEventBridgeToLambda
     * @param {cdk.App} scope - represents the scope for all the resources.
     * @param {string} id - this is a a scope-unique id.
     * @param props - user provided props for the construct
     */
    constructor(scope: Construct, id: string, props: S3ToEventBridgeToLambdaProps) {
        super(scope, id);
        defaults.CheckProps(props);

        let bucket: s3.IBucket;

        if (!props.existingBucketObj) {
            [this.s3Bucket, this.s3LoggingBucket] = defaults.buildS3Bucket(this, {
                bucketProps: {
                    ...props.bucketProps,
                    serverAccessLogsBucket: props.s3LoggingBucket,
                    serverAccessLogsPrefix: `${id}/`
                }
            });
            bucket = this.s3Bucket;
        } else {
            bucket = props.existingBucketObj;
        }

        (bucket.node.defaultChild as s3.CfnBucket).notificationConfiguration = {
            eventBridgeConfiguration: {
                eventBridgeEnabled: true
            }
        };

        if (props.s3LoggingBucket != undefined) {
            this.s3LoggingBucket = props.s3LoggingBucket;
        }

        let _eventRuleProps: events.RuleProps = {};
        if (props.eventRuleProps) {
            _eventRuleProps = props.eventRuleProps;
        } else {
            // By default the CW Events Rule will filter any 's3:PutObject' events for the S3 Bucket
            _eventRuleProps = {
                eventPattern: {
                    source: ['aws.s3'],
                    detailType: ['Object Created']
                }
            };
        }

        // create a dead-letter queue
        const _dlq = new sqs.Queue(this, 'DLQ', {
            encryption: sqs.QueueEncryption.KMS_MANAGED
        });

        let _lambdaFunc = defaults.buildLambdaFunction(this, {
            existingLambdaObj: props.existingLambdaObj,
            lambdaFunctionProps: props.lambdaFunctionProps
        });

        const _rule = new events.Rule(this, 'S3NotificatonRule', _eventRuleProps);
        _rule.addTarget(
            new targets.LambdaFunction(_lambdaFunc, {
                deadLetterQueue: _dlq,
                maxEventAge: Duration.days(1),
                retryAttempts: 10
            })
        );

        _lambdaFunc.addPermission('EventBusInvokeLambda', {
            principal: new iam.ServicePrincipal('events.amazonaws.com'),
            action: 'lambda:InvokeFunction',
            sourceArn: _rule.ruleArn
        });

        bucket.grantRead(_lambdaFunc.role!);

        this.eventsRule = _rule;
        this.lambdaFunction = _lambdaFunc;
    }
}
