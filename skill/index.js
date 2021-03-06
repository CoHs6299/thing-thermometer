/* eslint-disable  func-names */
/* eslint quote-props: ["error", "consistent"]*/
/**
 * An AWS IoT ESP8266 "kitchen/bbq" thermometer
 * 
 * This is the Alexa Skill for https://github.com/rogertheriault/thing-thermometer
 * 
 * It allows the user to control the thermometer alarm setpoints and obtain the
 * current temperature (and maybe one day, get notified of an alarm state)
 * 
 * There are two main modes: START and RECIPE. RECIPE is the state during a
 * recipe, returning to START when completely cooked.
 * 
 * Intents include:
 * * cook something
 * * general help
 * * help with a list of what can be cooked
 * * status request
 * * (during a recipe) cancel the recipe or go to the next step
 * * (optional) simulation / demo mode
 * 
 * Only one slot is used, the foodToCook
 * 
 * recipes.json is a resource that contains a list of recipes and steps
 * A user can request one of these, if found, the recipe starts
 * if not found the user is informed
 * 
 * To cook a recipe, the device shadow is updated with the desired mode and step
 * To obtain thermometer status, a combination of the thing shadow and the user's
 * state are used
 * 
 * The user's state is saved in dynamoDB using a feature of the Alexa SDK.
 * 
 * Copyright (c) 2018 Roger Theriault
 * Licensed under the MIT license.
 **/

'use strict';

// include the AWS SDK so we can access IoT and DynamoDB
const AWS = require('aws-sdk');

// support promise type stuff awkwardly still
const async = require("async");

// The Alexa SDK is helpful for template and state management
const Alexa = require('alexa-sdk');

// CDN URL for the background image and other assets
const CDN = process.env.CDN;
// if the URL is not set, default to the original github url
const PROJECT_SHORTURL = process.env.PROJECT_SHORTURL || "https://git.io/vAIQI";
// TODO put this in the CDN too
const recipes = require('./recipes.json');

// Set up a list of recipes that can be used
// TODO filter by thermometer/probe
// TODO stick this logic in a function
const recipe_options = recipes.map(recipe => recipe.title);
let separator = " or ";
const help_options = recipe_options.reduceRight( (previous, current) => {
    let string = current + separator + previous;
    separator = ", ";
    return string;
})

var alexa = {};

const languageStrings = {
    'en': {
        translation: {
            SKILL_NAME: 'Kitchen Helper',
            NOW_LETS_COOK: "OK, the thermometer is ready to go! ",
            HELP_MESSAGE: 'You can make ' + help_options + '. What can I help you with?',
            HELP_REPROMPT: 'What can I help you with?',
            STOP_MESSAGE: 'Goodbye!',
        },
    },
};

// These strings can be used to create a random response from the list
const speechText = {
    WELCOME_MESSAGE: [
        "Welcome, are we cooking today? ",
        "Hello, what would you like to cook? "
    ],
    HELP_MESSAGE: [
        'You can make ' + help_options + '. ',
        'You can cook a recipe, the choices are ' + help_options + '. '
    ],
    HELP_REPROMPT: [
        'What can I help you with? ',
        'What would you like to do? '
    ],
    STOP_MESSAGE: 'Goodbye!',
}

// OUR CUSTOM INTENTS
// cookSomething {foodToCook} (starts the recipe)
// getStatus
// nextStep
// SLOTS
// foodToCook = yogurt, ricotta

const states = {
    START: "_START",
    RECIPE: "_RECIPE" // cooking with a recipe
}

// default when no state is set (new session)
// all new sessions must call verifyThing
// verifyThing then routes control to the next intent handler and state
const handlers = {
    'LaunchRequest': function () {
        console.log('LaunchRequest');
        verifyThing.call(this, 'Welcome', states.START);
    },
    'getStatusIntent': function() {
        console.log('getStatusIntent');
        verifyThing.call(this, 'getStatusIntent', states.START);
    },
    // for now, send general help to the recipe options
    'AMAZON.HelpIntent': function() {
        console.log('HelpIntent');
        verifyThing.call(this, 'recipeOptionsIntent', states.START);
    },
    'recipeOptionsIntent': function() {
        console.log('recipeOptionsIntent');
        verifyThing.call(this, 'recipeOptionsIntent', states.START);
    },
    'cookSomethingIntent': function() {
        console.log('cookSomethingIntent');
        verifyThing.call(this, 'cookSomethingIntent', states.RECIPE);
    },
    'cancelRecipeIntent': function() {
        console.log('cancelRecipeIntent');
        verifyThing.call(this, 'cancelRecipeIntent', states.RECIPE);
    },
    'enableSimulationIntent': function() {
        console.log('enableSimulationIntent');
        // let this function handle all the logic
        createSimulatedThing.call(this);
    },
    'SessionEndedRequest': function () {
        console.log("SESSION ENDED");
        this.emit(':tell', getRandomItem('STOP_MESSAGE'));
    },
    "Unhandled": function() {
        console.log("UNHANDLED EVENT");
        console.log(JSON.stringify(this.event));
        this.handler.state = states.START;
        this.emitWithState(this.event.request.intent.name);
    }
}

// These handlers support the user after they's started a session, but are not in a recipe
const sessHandlers = Alexa.CreateStateHandler(states.START, {
    'LaunchRequest': function () {
        console.log('START LaunchRequest');
        verifyThing.call(this, 'Welcome', states.START);
    },
    'Welcome': function () {
        console.log('START Welcome');
        // user not cooking - ask them what they would like to cook
        // If the user was in a recipe, the Welcome handler for RECIPE state
        // should have received control
        let speechOutput = getRandomItem('WELCOME_MESSAGE');
        this.response.speak(speechOutput).listen(getRandomItem('HELP_REPROMPT'));
        this.emit(":responseReady");
    },
    // just get the current device status (we're not cooking)
    'getStatusIntent': function () {
        console.log('START getStatusIntent');
        getDeviceStatus.call(this);
    },
    'nextStepIntent': function () {
        console.log('START nextStepIntent');
        // not in recipe mode, so just tell the user they cannot do this
        let speechOutput = "You're not in a recipe right now. What would you like to cook? ";
        this.response.speak(speechOutput).listen(getRandomItem('HELP_REPROMPT'));
        this.emit(":responseReady");
    },
    // user has said they want to cook something, go to the RECIPE state
    'cookSomethingIntent': function () {
        console.log('START cookSomethingIntent');
        this.handler.state = states.RECIPE;
        this.emitWithState('cookSomethingIntent');
    },
    'cancelRecipeIntent': function () {
        console.log('START cancelRecipeIntent');
        this.handler.state = states.RECIPE;
        this.emitWithState('cancelRecipeIntent');
    },
    // asking for help should provide a different response than the options list
    'AMAZON.HelpIntent': function() {
        console.log('START HelpIntent');
        let speechOutput = "You can say cook a specific recipe, ask for " +
            " a list of recipes, or just get the thermometer status." +
            " <break time='.5s'/>"  +
            "When you're cooking something, you can go to the next step, get the " +
            "status, or cancel the recipe." +
            " <break time='.5s'/>"  +
            getRandomItem('HELP_REPROMPT');
        this.response.speak(speechOutput).listen(getRandomItem('HELP_REPROMPT'));
        this.emit(":responseReady");
    },
    // recipe help, user needs to know what they can cook
    'recipeOptionsIntent': function() {
        console.log("START recipeOptionsIntent");
        let speechOutput = getRandomItem('HELP_MESSAGE') + 
            " <break time='.5s'/>"  +
            getRandomItem('HELP_REPROMPT');
        this.response.speak(speechOutput).listen(getRandomItem('HELP_REPROMPT'));
        this.emit(":responseReady");
    },
    // Yes, simulate a thermometer. Not very useful!
    // this is just in place to (a) support certification and (b) satisfy folks
    // who might be too impatient to make their own
    // it is not enabled by default!
    'enableSimulationIntent': function() {
        console.log('START enableSimulationIntent');
        // let this function handle all the logic
        createSimulatedThing.call(this);
    },
    'AMAZON.CancelIntent': function () {
        console.log("START CancelIntent");
        showTemplate.call(this, {responseText: getRandomItem('STOP_MESSAGE')});
    },
    // This might be overkill, but assuming at this stage, we shouldn't be IN 
    // a recipe (state = START)
    // so this might fix invalid states
    'AMAZON.StopIntent': function () {
        console.log('START StopIntent');
        let responseText = "OK, goodbye."
        let desired = {};
        desired.alarm_high = 0;
        desired.alarm_low = 0;
        desired.mode = "";
        desired.step = 0;
        this.attributes["recipe"] = undefined;
        this.attributes["step"] = undefined;
        this.attributes["started"] = undefined;
        this.attributes["timestamp"] = Date.now();
        updateDevice.call(this, {desired, responseText});
    },
    'SessionEndedRequest': function () {
        console.log("SESSION ENDED");
        showTemplate.call(this, {responseText: getRandomItem('STOP_MESSAGE')});
    },
    "Unhandled": function() {
        console.log("START Unhandled event");
        console.log(JSON.stringify(this.event));
        var speechOutput = "Sorry, I didn't understand, can you try again please";
        this.emit(':ask', speechOutput);
    }
});


/**
 * in recipe state, we can only cancel, go to next step, or get status
 * 
 * TODO handle requests for info
 */
const recipeHandlers = Alexa.CreateStateHandler(states.RECIPE, {
    // recipe status
    // user came back during recipe, give them a brief status?
    'LaunchRequest': function() {
        console.log('RECIPE LaunchRequest');
        this.emitWithState('getStatusIntent');
    },
    // status during recipe
    'getStatusIntent': function () {
        console.log('RECIPE getStatusIntent');
        getDeviceStatus.call(this);
    },
    // "cancel the recipe" - must be explicit, to avoid accidentally cancelling
    'cancelRecipeIntent': function () {
        console.log('RECIPE cancelRecipeIntent');
        let responseText = "Stopping any active recipe now."
        let desired = {};
        desired.alarm_high = 0;
        desired.alarm_low = 0;
        desired.mode = "measure";
        desired.step = 0;
        this.attributes["recipe"] = undefined;
        this.attributes["step"] = undefined;
        this.attributes["started"] = undefined;
        this.attributes["timestamp"] = Date.now();
        // return to START state
        this.handler.state = states.START;
        updateDevice.call(this, {desired, responseText});
    },

    // proceed to the next step of the recipe (or finish it)
    'nextStepIntent': function () {
        console.log('RECIPE nextStepIntent');
        console.log(JSON.stringify(this.attributes));
        // get user's state and then get the next step and update the device
        let currentRecipe = this.attributes["recipe"];
        if ( ! currentRecipe ) {
            // this shouldn't happen unless states get messed up
            console.log("ERROR: user in RECIPE state but not in a recipe");
            this.handler.state = states.START;
            showTemplate.call(this, {
                responseText: "I'm sorry, you're not cooking anything right now.",
                prompt: "What else can I help you with?"
            });
            return;
        }
        
        // get the current step
        let stepid = this.attributes["step"];
        let currentStep = currentRecipe.steps.find(step => step.step == stepid);

        // if the current step is missing or complete, stop the recipe
        // NOTE this is an error case, the last step should be handled
        // by the code further down
        if ( (!currentStep) || currentStep.recipe === "complete") {
            this.handler.state = states.START;
            this.response.speak("Your recipe is complete! Would you like to cook something else?");
            desired.alarm_high = 0;
            desired.alarm_low = 0;
            desired.mode = "";
            desired.step = 0;
            this.attributes["recipe"] = undefined;
            this.attributes["step"] = undefined;
            this.attributes["started"] = undefined;
            this.attributes["timestamp"] = Date.now();
            this.emit(':saveState', true);
            updateDevice.call(this, {desired, responseText, displayText, prompt} );
            return;
        }

        // next step
        stepid += 1;
        let newStep = currentRecipe.steps.reduce((curr, prev) => {
            return (curr.step === stepid) ? curr : prev;
        })
        
        // if there's no next step, go to idle mode
        if (!newStep || newStep.recipe === "complete") {
            // last step, no need to save the state, in fact,
            // it needs to be removed
            this.handler.state = states.START;
            this.attributes['recipe'] = undefined;
            this.attributes["step"] = undefined;
            this.attributes["started"] = undefined;
        } else {
            // intermediate step
            // save state
            this.attributes['step'] = stepid;
        }
        // at some point we might have to "clean up" (discard) ancient states
        this.attributes['timestamp'] = Date.now();
        
        // compose a response, from the recipe data
        let responseText = newStep.speak;
        let displayText = newStep.display; // TODO more info

        // set up the desired shadow state for the device
        let desired = {};
        desired.alarm_high = newStep.alarm_high || null;
        desired.alarm_low = newStep.alarm_low || null;
        desired.timer = newStep.timer || null;
        desired.step = stepid;

        // update the device and then respond to the user
        updateDevice.call(this, {desired, responseText, displayText});
    },

    // start cooking
    'cookSomethingIntent': function () {
        console.log('RECIPE cookSomethingIntent');

        // DO NOT proceed further if we're in a recipe...
        if (this.attributes["step"] || this.attributes["recipe"]) {
            console.log("User state: " + this.attributes["step"]);
            let food = this.attributes["recipe"].title || 'something';

            showTemplate.call(this, {
                responseText: "You're already cooking " + food + ". " +
                    "To cook something else, just say 'cancel the recipe' first.",
                prompt: "What would you like to do?"
            });
            return;
        }


        // No active recipe - make sure we have a recipe for the foodToCook slot

        // handle cooking yogurt or ricotta cheese
        const slots = this.event.request.intent.slots;
        let responseText = "";
        let displayText = "";
        if (slots.foodToCook.value) {
            const food = slots.foodToCook.value;
            console.log( food );

            // attempt to retrieve the recive matching the food
            const recipe = getRecipe(food);
            console.log( recipe );
            if ( !recipe ) {
                console.log("Unknown recipe: " + food);
                // TODO log a list of food requests
                responseText = "I can't handle making " + food + " yet, sorry. ";
                this.handler.state = states.START;
                showTemplate.call(this, {
                    responseText,
                    prompt: "Would you like to cook something else?"
                });
                return;
            }
            // get the first step or the step with step = 1
            const firstStep = recipe.steps.reduce((prev,curr) => {
                return (curr.step === 1) ? curr : prev;
            });
            responseText = recipe.speak + " " + firstStep.speak;
            displayText = "Making " + recipe.title + "<br/>" + firstStep.display;

            let desired = {};
            desired.alarm_high = firstStep.alarm_high || null;
            desired.alarm_low = firstStep.alarm_low || null;
            desired.timer = firstStep.timer || null;
            desired.mode = recipe.id;
            desired.step = 1; // start at 1

            // save state
            this.attributes['recipe'] = recipe;
            this.attributes['step'] = 1;
            this.attributes['timestamp'] = Date.now();
            this.attributes['started'] = Date.now();

            updateDevice.call(this, {desired, responseText, displayText});
        } else {
            console.log("Asking for a foodToCook");
            this.emit(':elicitSlot', "foodToCook", "I can make " + help_options +
                ", Which would you like?", "Please say that again?");
        }

    },
    // An explicit "cancel the recipe" is handled by the cancelRecipeIntent
    // user may have said no to "What would you like to do?"
    // Just quit
    'AMAZON.StopIntent': function () {
        console.log("RECIPE StopIntent");
        showTemplate.call(this, {responseText: getRandomItem('STOP_MESSAGE')});
    },
    'AMAZON.CancelIntent': function () {
        console.log("RECIPE CancelIntent");
        showTemplate.call(this, {responseText: getRandomItem('STOP_MESSAGE')});
    },
    'AMAZON.NoIntent': function () {
        console.log("RECIPE NoIntent");
        showTemplate.call(this, {responseText: getRandomItem('STOP_MESSAGE')});
    },

    // asking for help here should explain what you can do WHILE cooking
    'AMAZON.HelpIntent': function() {
        console.log('START HelpIntent');
        let speechOutput = 
            "While you're cooking something, you can go to the next step, get the " +
            "status, or to stop cooking, say 'cancel the recipe'." +
            " <break time='.5s'/>"  +
            getRandomItem('HELP_REPROMPT');
        this.response.speak(speechOutput).listen(getRandomItem('HELP_REPROMPT'));
        this.emit(":responseReady");
    },

    'SessionEndedRequest': function () {
        console.log("SESSION ENDED");
        showTemplate.call(this, {responseText: getRandomItem('STOP_MESSAGE')});
    },
    "Unhandled": function() {
        console.log("RECIPE Unhandled event");
        console.log(JSON.stringify(this.event));
        var speechOutput = "Sorry, can you try again please";
        this.emit(':ask', speechOutput);
    }
});

exports.handler = function (event, context, callback) {
    // NOTE alexa is already defined as a global so functions can access it
    alexa = Alexa.handler(event, context, callback);

    alexa.appId = process.env.APP_ID;
    alexa.dynamoDBTableName = process.env.DYNAMODB_STATE_TABLE;

    console.log('START');
    console.log(JSON.stringify(event));

    // To enable string internationalization (i18n) features, set a resources object.
    alexa.resources = languageStrings;

    alexa.registerHandlers(handlers, sessHandlers, recipeHandlers);
    alexa.execute();
}

/*
 * fetch a Thing's shadow state and respond to the user
 * 
 * This is reasonably fast but we might also want to try Alexa's new async
 * responses i.e. Progressive Response
 * 
 * Note we might enter this code from the START or RECIPE state
 */
function getDeviceStatus() {
    // sess will point to "this" in the async callbacks
    let sess = this;
    console.log("getting device status");
    let thingId = this.attributes["thingId"];
    if ( !thingId ) {
        console.log("Get device: no id");
        // TODO handle this, it should be caught by earlier code 99% of the time
        this.emit(':tell', "You don't seem to have a device");
        return false;
    }
    // TODO wrap this into a helper
    // get the thing shadow and report back to user
    var thing = new AWS.IotData({endpoint: process.env.THING_API});
    var params = {
        thingName: thingId
    }
    thing.getThingShadow(params, function (err, data) {
        if (err) {
            // do something
            console.log('getThingShadow error:');
            console.log(err);
            // fall through to error response
        } else {
            // retrieved shadow state
            console.log('getThingShadow success:');
            console.log(data);
            var shadow = JSON.parse(data.payload);
            console.log(shadow);
            let reported = shadow.state.reported || {};
            // TODO handle no reported structure

            let mode = reported.mode || "measure";
            let cooking = "thermometer";
            let recipe = false;
            let currentRecipe = {};
            if ( mode && mode !== "measure" ) {
                recipe = true;
                // TODO bundle this into a helper
                // get the current step from the user's state
                currentRecipe = sess.attributes["recipe"];
            }
            // if the temperature makes sense, format a response
            if (reported.temperature && 
                reported.temperature !== 0 && 
                reported.temperature < 2000) {

                let currentTemp = reported.temperature;//.value;
                let units = "celsius";// TODO use shadow.state.reported.temperature.units;
                let txtUnits = (units === "fahrenheit") ? "F" : "C";

                let responseText = "The thermometer is reporting " + 
                    currentTemp + " degrees. ";
                // if in a recipe, show the step and check if we should go to the
                // next step, otherwise just show the temperature
                if (recipe) {
                    let stepid = reported.step || sess.attributes["step"];
                    let currentStep = currentRecipe.steps.find(step => step.step == stepid);
                    let reached = false;
                    let targetTemp = false;
                    console.log("in recipe");

                    // format a message if the temperature was reached
                    if (reported.alarm_high) {
                        targetTemp = reported.alarm_high;
                        reached = (targetTemp <= reported.temperature) ?
                            "exceeded " + targetTemp + " degrees " :
                            false;
                    }
                    if (!reached && reported.alarm_low) {
                        targetTemp = reported.alarm_low;
                        reached = (targetTemp >= reported.temperature) ?
                            "gone below " + targetTemp + " degrees " :
                            false;
                    }
                    let reportTarget = "";
                    if (targetTemp) {
                        reportTarget = "Target " + targetTemp + "°" + txtUnits + (reached ? " REACHED" : "")
                    }
                    let recipeName = currentRecipe.title;
                    // append to the spoken response
                    responseText += "You're making " + recipeName + ". ";
                    if (reached) {
                        responseText += " You've " + reached + 
                            " and can go to the next recipe step. ";
                    }
                    let prompt = "What would you like to do next?";
                    let displayText = "Making " + recipeName + "<br/>" +
                        currentStep.summary + "<br/>" +
                        "<b>" + currentTemp + "°" + txtUnits + "</b><br/>" +
                        "<font size=\"2\">" + reportTarget + "</font>";
                    showTemplate.call(sess, {responseText, prompt, displayText});

                } else {
                    // not in a recipe, no prompt (and set START state just in case)
                    sess.handler.state = states.START;
                    let displayText = "Thermometer:<br/><b>" + currentTemp + "°" + txtUnits + "</b>";
                    showTemplate.call(sess, {responseText, displayText});
                }
                return;
            } else {
                alexa.emit(':tell', "Your device may be off");
                return;
            }
        }
        // we really shouldn't arrive here
        alexa.emit(':tell', "I'm sorry Dave, I can't do that");
    });
}

/*
 * request a device shadow change and then respond to the user
 * 
 * update contains these attributes:
 * * desired - the desired state to send
 * * responseText - text for Alexa to speak (optional)
 * * prompt - an optional question to ask (optional)
 * * displayText - text to put on a device, if supported (optional)
 */
function updateDevice(update) {
    console.log("controlling a device");
    console.log(JSON.stringify(update));

    // the user's thing id to update
    let thingId = this.attributes["thingId"];
    // save "this" so the callback can reference it
    let sess = this;
    if ( !thingId ) {
        console.log('Update: no device id');
        return;
    }
    // IotData is the IoT API
    var thing = new AWS.IotData({endpoint: process.env.THING_API});
    // set up the data to send to the API
    var payload = { 
        state: {
            desired: update.desired
        }
    };
    var params = {
        thingName: thingId,
        payload: JSON.stringify(payload)
    };
    // Perform the update. The callback receives the result
    thing.updateThingShadow(params, function (err, data) {
        console.log("returned from shadow update");
        console.log(update);

        // err is an error, log it until we see some real ones
        if (err) {
            // do something
            console.log('updateThingShadow error:');
            console.log(err);
            sess.emit(':tell', "Oh gosh, something went wrong!");
        } else {
            console.log('updateThingShadow success:');
            console.log(data);
            // if the responseText is set, then call showTemplate
            // to respond to the user with voice and text on supported devices
            if ( update.responseText ) {
                showTemplate.call(sess, update);
            }
        }
    });
}
/**
 * return a recipe object matching a "Food" slot
 * 
 * Recipes can match multiple utterances e.g. "ricotta cheese" and "ricotta"
 * 
 * @param {String} slot 
 */
function getRecipe(slot) {
    let matches = recipes.filter(recipe => recipe.slots.includes(slot));
    if (matches.length > 0) {
        return matches[0];
    }
    return null;
}

/**
 * Utility to set a user's thing ID in their session attributes
 * 
 * will check user's saved session data before looking in the userdevices table
 * Currently only supports one device per user
 * Once the ID is set, it can be accessed in attributes["thingId"]
 * 
 * The callback is called once the attribute is set
 * NOTE this only needs to be called when a new session starts
 * 
 * @param {function} callback - callback to execute after id retrieved
 */
function setUserThingId(callback) {
    // TEST no id callback( false );
    // TEST no id return;
    if ( this.attributes && this.attributes["thingId"] ) {
        console.log("using thing " + this.attributes["thingId"]);
        if ( callback ) {
            callback( this.attributes["thingId"] );
            return;
        }
    }

    let userId = this.event.session.user.userId;
    // look in the USER/DEVICES table for the thing Id
    const ddb = new AWS.DynamoDB({apiVersion: '2012-10-08'});

    var params = {
        TableName: process.env.DYNAMODB_THING_TABLE,
        Key: {
            'userId': {"S": userId},
        },
        AttributesToGet: [ 'thingId' ]
    };

    // Call DynamoDB to read the item from the table
    let getItemPromise = ddb.getItem(params).promise();
    getItemPromise.then( (data) => {
        // data.Item looks like:
        // { thingId: {S: "actualId"} }
        let thingId = data.Item.thingId.S;
        console.log("Found user thing " + thingId);
        // save in user session
        this.attributes["thingId"] = thingId;
        if ( callback ) {
            callback( thingId );
            return;
        }
        console.log("Callback missing");
    })
    .catch( err => {
        console.log("Error with getItem");
        console.log(err);
        console.log("Failed to find a Thing");
        callback( false );
    });

    // failed
}

function supportsDisplay() {
    let hasDisplay = this.event.context 
        && this.event.context.System 
        && this.event.context.System.device 
        && this.event.context.System.device.supportedInterfaces 
        && this.event.context.System.device.supportedInterfaces.Display;
  
    return hasDisplay;
}

/**
 * make sure the user has a Thing
 * 
 * If the user does not have a thing, all we can do is issue
 * a link to the project
 * 
 * @param {String} nextIntent - the id of the next intent
 * @param {String} nextState - the next state (START or RECIPE)
 */
function verifyThing(nextIntent, nextState) {
    setUserThingId.call(this, (thingId) => {
        if ( ! thingId ) {
            let speechOutput = "You'll need to set up a thermometer first. " +
                "I've added a link to your Alexa app with information about " +
                "creating your own thermometer.";
            let displayText = "This skill demonstrates controlling an IoT device with Alexa " +
                "and Arduino. You can create your own device and Alexa skill " +
                "with the instructions at the following link: " + PROJECT_SHORTURL;

            // virtual device (optional and not enabled by default)
            if (process.env.SIMULATE_GROUP) {
                displayText += " \nIf you'd like to simulate the device, " +
                    "try 'Alexa, ask Kitchen Helper to simulate a thermometer'.";
            }

            // TODO account linking card and instructions
            // For development use this should suffice
            console.log("NO THING: Sending the info card to the user");
            this.emit(':tellWithCard', speechOutput, this.t('SKILL_NAME'),
                displayText );
            return;

        }
        // user does have a connected Thermometer Thing
        console.log("Thing found, jumping to " + nextState + ":" + nextIntent);
        this.handler.state = nextState;
        this.emitWithState(nextIntent);
    });
}

/**
 * get a random string from a list
 * 
 * @param {String} optionKey
 */
function getRandomItem(optionKey) {
    let options = speechText[optionKey] || "";
    if (typeof options === "string") {
        return options;
    }
    let index = Math.floor(Math.random() * options.length);
    return options[index];
}

/**
 * display a response, with template (if supported), and end, saving state
 * 
 * This is a catch-all to handle optional display template output prior
 * to returning control to the user
 * 
 * Invoke with showTemplate.call(this, params) to pass the context
 * 
 * all params are optional, but responseText is highly recommended unless
 * you've used this.response.speak() prior to calling showTemplate()
 * 
 * responseText - will be spoken
 * displayText - will appear in template
 * prompt - add a listen
 */
function showTemplate(params) {

    // if prompt is present, then speak & ask, else just speak
    if ( params.responseText ) {
        if ( params.prompt ) {
            console.log("speaking/listening: " + 
                params.responseText + " <break time='.5s'/>" + params.prompt)
            this.response
                .speak(params.responseText + " " + params.prompt)
                .listen(params.prompt);
        } else {
            console.log("speaking: " + params.responseText)
            this.response
                .speak(params.responseText);
        }
    }
    if (params.displayText && supportsDisplay.call(this)) {
        // utility methods for creating Image and TextField objects
        const makeRichText = Alexa.utils.TextUtils.makeRichText;
        const makeImage = Alexa.utils.ImageUtils.makeImage;

        const builder = new Alexa.templateBuilders.BodyTemplate1Builder();

        const template = builder.setTitle(this.t('SKILL_NAME'))
            .setBackgroundImage(makeImage(CDN + '/gas-stove-bg.jpg'))
            .setTextContent(makeRichText(params.displayText))
            .build();

        console.log("template: " + params.displayText)
        this.response.renderTemplate(template);
    }
    console.log('saving state');
    this.emit(':saveState', true)
    this.emit(':responseReady');
}


/**
 * totally optional unnecessary simulation utilities
 * 
 * create a random thing id if a user requests a simulation
 * attach it to the user's id
 * the simulated thing is put in a special group and a lambda updates the state
 * of each thing once a minute
 */
function createSimulatedThing() {
    let maybeThing = this.attributes["thingId"];
    if (maybeThing) {
        if (maybeThing.substr(0,4) === "SIM_") {
            // no point in doing this twice
            this.emit(":tell", "You already have a simulated thermometer.");
        } else {
            // user actually has a real device, yay!
            this.emit(":tell", "You don't need a simulation.");
        }
        return;
    }

    // general catch-all phrase if something doesn't work
    const oops = "Sorry, simulations are not available right now";
    if (!process.env.SIMULATE_GROUP) {
        this.emit(":tell", oops);
    }
    const iot = new AWS.Iot();
    // preserve this in callbacks
    let sess = this;

    // create a thing
    const thingId = randomID();
    iot.createThing({thingName: thingId}, function(err, data) {
        if (err) {
            sess.emit(":tell", oops);
            return;
        }
        if (data) {
            // add it to the simulation group
            iot.addThingToThingGroup({
                thingName: thingId,
                thingGroupName: process.env.SIMULATE_GROUP
            }, function(err, data) {
                if (err) {
                    sess.emit(":tell", oops);
                    return;
                }
                if (data) {
                    // add it to dynamDB
                    let userId = sess.event.session.user.userId;
                    // USER/DEVICES table for the thing Id
                    const ddb = new AWS.DynamoDB({apiVersion: '2012-10-08'});

                    var params = {
                        TableName: process.env.DYNAMODB_THING_TABLE,
                        Item: {
                            "userId": {"S": userId},
                            "thingId": {"S": thingId}
                        }
                    };

                    let putItemPromise = ddb.putItem(params).promise();
                    putItemPromise.then( (data) => {

                        // create the first state and let the user know
                        const iotdata = new AWS.IotData({endpoint: process.env.THING_API});
                        let newState = {
                            reported: {
                                temperature: 15
                            }
                        }
                        iotdata.updateThingShadow({
                            thingName: thingId,
                            payload: JSON.stringify({state: newState})
                        }, function(err, data) {
                            if (err) {
                                console.log(err);
                                sess.emit(":tell", oops);
                                return;
                            }
                            console.log(data);
                            if (data) {
                                // it all worked, whew
                                sess.attributes["thingId"] = thingId;
                                let params = {
                                    responseText: "I've set up a simulated thermometer for you. ",
                                    displayText: "Simulation Enabled",
                                    prompt: "What would you like to do?"
                                }
                                showTemplate.call(sess, params);
                            }
                        });
                    });
                }
            })
        }
    })
}

// see https://gist.github.com/gordonbrander/2230317
function randomID() {
    // Math.random should be unique because of its seeding algorithm.
    // Convert it to base 36 (numbers + letters), and grab the first 9 characters
    // after the decimal.
    return 'SIM_' + Math.random().toString(36).substr(2, 9);
};
