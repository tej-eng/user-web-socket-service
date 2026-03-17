 // No need to call it a second time


import swaggerAutogen from 'swagger-autogen';

const doc = {
  info: {
    title: 'My API',
    description: 'API documentation',
  },
  host: 'localhost:8001',
  schemes: ['http'],
};

const outputFile = './swagger-output.json';
const endpointsFiles = ['./routes/*.js']; 


swaggerAutogen(outputFile, endpointsFiles, doc);
