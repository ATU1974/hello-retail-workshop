# Hello, Retail! The workshop.
This github repository is intended to accompany the working code in https://github.com/Nordstrom/hello-retail
For our Nordstrom internal serverless conference, participants take part in an interactive exercise using hello-retail, they then extend it using this workshop.

![Serverless all the things!](Images/artillery-shooting-lambda.png)

###TL;DR:
Hello-retail is a Nordstrom open-source project. It is intended to showcase a simple 100% serverless, event-driven retail architecture.  All code and patterns are intended to be re-usable for scalable applications large and small.

##Technologies used for this workshop
* **AWS Lambda** One way of thinking about it is 'functions as a service.'
* **AWS Kinesis** The stream.  Technically a durable replicated log.
* **AWS API Gateway** A fully-managed web-service front-end.  Resources, methods, authentication.  Trigger lambdas to do the work.
* **AWS DynamoDB** NoSQL tables.  Used here as a simple key-value store.
* **Serverless Application Framework** is an open source project with lots of handy tools to manage serverless configurations, shared code, and deploy your work.

##Why?
Serverless architectures offer incredible promise to reduce code complexity, operations costs, improve scalability, and when used correctly, security.  When you go serverless, you probably quickly arrive at event-driven architectures.  These are naturally matched with stateless event-driven AWS Lambda functions.

![Serverless all the things!](Images/hello-retail-icon.png)

In this diagram we see how ***

##What does all of this cost?
AWS Lambda charges based on both the number of invocations and the duration of each function. For simple functions like these, assume about $.20 per million invocations.
AWS API Gateway is about $3.50 per million calls.
AWS DynamoDB for up to 5TPS in this example should cost less than $4 a month.

##Kudos!
* Huge props and all credit for the hello-retail code is due to Erik Erikson and Greg Smith, our senior developers behind all of this code.
* Our amazing new developer Lauren Wang created all of the code for this workshop... in two weeks!
* Clearly, special thanks are due to Austen Collins and the rest of the crew at Serverless, Inc. who gave us the Serverless Framework, sparked our imaginations, and saved us a lot of pain.  Being in production with serverless architecture and staying sane requires a deployment framework, our pick is the Serverless.com Framework.

##We humbly request your thoughts and feedback
All feedback is welcomed - so don't be shy!