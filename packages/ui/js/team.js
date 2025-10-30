import {
    input,
    print
} from './main.js'

// Global variables for data operations
let inputState = false;
let currentStage = "";
let currentData = "";
let pendingOperation = "";

// Data
const employees = [];

const newEmployeeInfo = {
    name : "",
    rate : 0,
    hours : 0,
    isManager : false,
}

class Employee {
    constructor(_name, _rate, _hours) {
        this.name = _name;
        this.rate = _rate; 
        this.hours = _hours;
        // this.salary = this.rate * this.hours * 52;
        // Static variable, doesn't play nice with Edit function
    }

    getSalary() {
        return this.rate * this.hours * 52;
    }
}

class Manager extends Employee {
    constructor(_name, _rate, _hours) {
        super(_name, _rate, _hours);
        this.role = "Manager";
    }
}

class PartTime extends Employee {
    constructor(_name, _rate, _hours) {
        super(_name, _rate, _hours);
        this.role = "Part Time";
    }
}

class Main {
    // Used static to avoid having to instantiate the class
    static isBlocking() {
        return inputState;
    }

    // Okay. This guy is HUGE and a little unwieldy. There's got to be a better way to handle this
    // But I'm very sleepy
    static handleSubKeydown(e) {
        if(e.key==='Enter'){
            e.preventDefault();

            // Abort if not in inputState
            if(!inputState) return;

            if(input.value.toLowerCase() === "cancel") {
                // Reset
                input.value = "";
                console.error("Canceled");
                inputState = false;
                currentStage = "";
                return;
            };

            const outputLine = document.querySelector("#output > div:last-of-type > span");

            // That's the basics out of the way. Now we check for the currentStage global up top
            // That indicates that one of the methods below is running
            // If a currentStage is detected, these handlers validate data and loop/abort if rejected
            // If validation passes, data is handled and the stage is advanced, and the current method is run again
            // The methods check for completion on each loop and wrap things up if true
            // Otherwise they do nothing and the eventListeners wait for user input.
            // When the user hits enter, this switch will run again.
            // And repeat until the user cancels or finishes their operation
            switch (currentStage) {
                // HANDLERS FOR EDIT FUNCTION
                case "editName":
                    // Validation
                    const proposedNameEdit = input.value;

                    // Check for blank submission
                    if (!proposedNameEdit) {
                        currentStage = "editRate";
                        console.info("Rate:");
                        Main.selectEmployee(currentData, pendingOperation);
                        break;
                    }
                    // Check for existing names
                    if (employees.findIndex(emp => emp.name.toLowerCase() === proposedNameEdit.toLowerCase()) >= 0) {
                        console.error(`An employee named "${proposedNameEdit}" already exists.`);
                        console.info('Enter a different name:');
                        break;
                    }

                    // Success
                    employees[currentData].name = proposedNameEdit;
                    outputLine.innerHTML = `${outputLine.innerHTML} - ${proposedNameEdit}`;
                    currentStage = "editRate";
                    console.info("Rate:");
                    Main.selectEmployee(currentData, pendingOperation);
                    break;


                case "editRate":
                    // Success
                    const proposedRateEdit = input.value;
                    if (!proposedRateEdit) {
                        currentStage = "editHours";
                        console.info("Hours:");
                        Main.selectEmployee(currentData, pendingOperation);
                        break;
                    } else if (proposedRateEdit > 0) {
                        employees[currentData].rate = proposedRateEdit;
                        outputLine.innerHTML = `${outputLine.innerHTML} - ${input.value}`;
                        currentStage = "editHours";
                        console.info("Hours:");
                        Main.selectEmployee(currentData, pendingOperation);
                        break;
                    } else {
                        // Validation
                        console.error("Must be a positive number.");
                        console.info("Rate:");
                        break;
                    }


                case "editHours":
                    const proposedHoursEdit = input.value;
                    // Validation 1
                    if (!proposedHoursEdit) {
                        currentStage = "editIsManager";
                        console.info("Manager? Y/N");
                        break;
                    } else if (proposedHoursEdit > 168) {
                        console.error("Only 168 hours in a week.");
                        console.info("Hours:");
                        break;
                    } // Success
                    else if (proposedHoursEdit > 0) {
                        employees[currentData].hours = proposedHoursEdit;
                        outputLine.innerHTML = `${outputLine.innerHTML} - ${input.value}`;
                        currentStage = "editIsManager";
                        console.info("Manager? Y/N");
                        Main.selectEmployee(currentData, pendingOperation);
                        break;
                    } else {
                        // Validation 2
                        console.error("Must be a positive number.");
                        console.info("Hours:");
                        break;
                    }


                case "editIsManager":
                    if (!input.value) {
                        currentStage = "editEmployeeComplete";
                        break;
                    }
                    input.value = input.value.toUpperCase();
                    if(input.value === "Y") employees[currentData].isManager = true;
                    else if(input.value === "N") employees[currentData].isManager = false;
                    else {
                        console.error("Invalid input.")
                        console.info("Manager? Y/N");
                        Main.selectEmployee(currentData, pendingOperation);
                        break;
                    }
                    outputLine.innerHTML = `${outputLine.innerHTML} - ${input.value}`;
                    currentStage = "editEmployeeComplete";
                    // No break; fall through to next one

                // Handle complete
                case "editEmployeeComplete":
                    // Console confirmation
                    console.log(`${employees[currentData].name} edited successfully`);

                    // Reset
                    inputState = false;
                    currentStage = "";
                    pendingOperation = "";
                    input.value = "";
                    break;


                case "editEmployee":
                    console.info("Name:");
                    currentStage = "editName";
                    Main.selectEmployee(currentData, pendingOperation);
                    break;
                    

                // HANDLERS FOR ADD FUNCTION
                case "getName":
                    // Validation
                    const proposedName = input.value;

                    // Check for blank submission
                    if (!proposedName) {
                        console.error('Name cannot be blank.');
                        console.info('Name?');
                        break;
                    }
                    // Check for existing names
                    if (employees.findIndex(emp => emp.name.toLowerCase() === proposedName.toLowerCase()) >= 0) {
                        console.error(`An employee named "${proposedName}" already exists.`);
                        console.info('Enter a different name:');
                        break;
                    }

                    // Success
                    newEmployeeInfo.name = proposedName;
                    outputLine.innerHTML = `${outputLine.innerHTML} - ${proposedName}`;
                    currentStage = "getRate";
                    console.info("Rate:");
                    Main.addEmployee();
                    break;


                case "getRate":
                    // Success
                    const proposedRate = input.value;
                    if (proposedRate > 0) {
                        newEmployeeInfo.rate = proposedRate;
                        outputLine.innerHTML = `${outputLine.innerHTML} - ${proposedRate}`;
                        currentStage = "getHours";
                        console.info("Hours:");
                        Main.addEmployee();
                        break;
                    } else {
                        // Validation
                        console.error("Must be a positive number.");
                        console.info("Rate:");
                        break;
                    }       
                    
                    
                case "getHours":
                    const proposedHours = input.value;
                    // Validation 1
                    if (proposedHours > 168) {
                        console.error("Only 168 hours in a week.");
                        console.info("Hours:");
                        break;
                    } // Success
                    else if (proposedHours > 0) {
                        newEmployeeInfo.hours = proposedHours;
                        outputLine.innerHTML = `${outputLine.innerHTML} - ${proposedHours}`;
                        currentStage = "getManager";
                        console.info("Manager? Y/N");
                        Main.addEmployee();
                        break;
                    } else {
                        // Validation 2
                        console.error("Must be a positive number.");
                        console.info("Hours:");
                        break;
                    }

                case "getManager":
                    input.value = input.value.toUpperCase();
                    if(input.value === "Y") newEmployeeInfo.isManager = true;
                    else if(input.value === "N") newEmployeeInfo.isManager = false;
                    else {
                        console.error("Invalid input.")
                        console.info("Manager? Y/N");
                        break;
                    }
                    outputLine.innerHTML = `${outputLine.innerHTML} - ${input.value}`;
                    currentStage = "addEmployeeComplete";
                    Main.addEmployee();
                    break;


                case "addEmployee":
                    console.info("Name:");
                    currentStage = "getName";
                    Main.addEmployee();
                    break;


                // HANDLERS FOR SELECT FUNCTION
                case "getEmployee":
                    console.info("Select a user by full name or ID:");
                    currentStage = "getEmployee1";
                    break;


                case "getEmployee1":
                    
                    const userArgs = input.value;

                    // If blank, error. Else pass for later validation
                    if (!userArgs) {
                        console.error("Invalid input.")
                        console.info("Select a user by full name or ID:");
                        break;
                    } else {
                        currentData = userArgs;
                        currentStage = "getEmployeeComplete";
                        Main.selectEmployee(userArgs, pendingOperation);
                        break;
                    }      
            }

            // Reset and return once finished
            input.value = "";
            return;
        }
    }

    static addEmployee() {
        // Setup
        inputState = true;
        if (currentStage === "") {
            console.log("Adding new employee. Type 'cancel' at any time to abort.");
            currentStage = "addEmployee";
        }
            
        // Output transient data to finished object
        if (currentStage === "addEmployeeComplete") {
            // Reset
            inputState = false;
            currentStage = "";

            if(newEmployeeInfo.isManager) {
                employees.push(new Manager(newEmployeeInfo.name, newEmployeeInfo.rate, newEmployeeInfo.hours));
            } else if ((newEmployeeInfo.rate * newEmployeeInfo.hours) <= 35) {
                employees.push(new PartTime(newEmployeeInfo.name, newEmployeeInfo.rate, newEmployeeInfo.hours));
            } else {
                employees.push(new Employee(newEmployeeInfo.name, newEmployeeInfo.rate, newEmployeeInfo.hours));
            }

            console.log(`Successfully added ${employees[employees.length - 1].name}`);
        }
    }

    // This is a BIG ONE. This method selects an employee AND runs an operation on them, passed in from main.js
    // Pairs initimately with handleSubKeydown to get user input
    static selectEmployee(argv, operation) {
        let validated = false;
        pendingOperation = operation;

        if (employees.length == 0) {
            console.log("No employees found");
            return;
        }

        if (currentStage === "") {
            // Set up input state
            inputState = true;
            currentStage = "getEmployee";
        }

        // Get user from currentData
        if (currentStage == "getEmployeeComplete") {
            // If number:
            if ((parseInt(currentData) - 1) >= 0 && (parseInt(currentData) - 1) < employees.length) {
                // Reset
                inputState = false;
                currentStage = "";
                currentData = parseInt(currentData) - 1;
                validated = true;
            } else {
                // Otherwise, attempt to find name match. Should always work, protected above by handler switch case getEmployee1
                // Reset
                inputState = false;
                currentStage = "";
                currentData = employees.findIndex(emp => emp.name.toLowerCase() === currentData.toLowerCase());
                validated = true;
            }
        }
        
        
        // Run on first call only and only if no args were supplied, otherwise attempt to run args
        if ((!argv) && (currentStage == "getEmployee")) {
            // Display all employees
            for(let i = 0; i < employees.length; i++) {
                if (i < 9) console.log(`0${i + 1}: ${employees[i].name}`);
                else if (i >= 9) console.log(`${i + 1}: ${employees[i].name}`);
                else {
                    console.error("An unspecified error occurred.");
                }
            }
            if (pendingOperation == "list") {
                inputState = false;
                currentStage = "";
                currentData = "";
                validated = true;
            };
        } else if (typeof argv == 'string' && currentStage == "getEmployee") {
            currentData = argv;

            // If number:
            if ((parseInt(currentData) - 1) >= 0 && (parseInt(currentData) - 1) < employees.length) {
                // Reset
                inputState = false;
                currentStage = "";
                currentData = parseInt(currentData) - 1;
                validated = true;
            } else {
                // Otherwise, attempt to find name match. Should always work, protected above by handler switch case getEmployee1
                // Reset
                inputState = false;
                currentStage = "";
                currentData = employees.findIndex(emp => emp.name.toLowerCase() === currentData.toLowerCase());
                validated = true;
            } 
        }

        // Selection successful. Validate. If fail, reset and abort
        if (currentData < 0 || currentData > employees.length) {
            console.error("No matching employee found.");
            currentStage = "";
            pendingOperation = "";
        }
        
        // Validated. Run operation
        if (validated) {
            switch (pendingOperation) {
                // Remove employee
                case "remove":
                    const confirmationName = employees[currentData].name;
                    // Used Splice instead of Filter (personal preference)
                    employees.splice(currentData, 1);
                    console.log(`Successfully removed ${confirmationName}`)
                    break;

                // Edit employee
                case "edit":
                    console.log(`Editing ${employees[currentData].name}. Press Enter to keep current value. Type 'cancel' to abort`);
                    inputState = true;

                    // Setup
                    if (currentStage == "") {
                        currentStage = "editEmployee";
                    }

                    Main.selectEmployee(currentData, pendingOperation);
                    break;

                // Display employee data
                case "display":
                    let employeeRole = "";
                    if(!employees[currentData].role) {
                        employeeRole = "Full Time";
                    } else {
                        employeeRole = employees[currentData].role;
                    }
                    console.log(`Employee details: ${employees[currentData].name}`)
                    console.log(`-------------------------------`);
                    console.log(`Pay rate:           $${employees[currentData].rate} / hour`);
                    console.log(`Hours / week:       ${employees[currentData].hours}`);
                    console.log(`Avg yearly income:  $${employees[currentData].getSalary().toLocaleString()}`);
                    console.log(`Role:               ${employeeRole}`);
                    break;
            }

            // Big reset after successful operation
            if (pendingOperation !== "edit" || currentStage === "editEmployeeComplete") {
                currentStage = "";
                currentData = "";
                pendingOperation = "";
                inputState = false;
                input.value = "";
            }
        }

    // Pseudocode
    // 1: SELECT
    // If command has args
        // If args are text
            // Attempt to find employee with matching name
        // If args are number
            // Attempt to find employee (index = ID - 1)
    // If no args:
        // Show all employees
        // Request ID from user

        // 2A: REMOVE
            // Confirm user wants to remove employee NAME
            // Break or continue
            // Splice out employee (index = ID - 1)

        // 2B: EDIT
            // Confirm user wants to edit employee Name
            // Break or continue
            // Save current employee index as global (currentData)
            // Run through all attributes (just like adding)
            // Edit, or skip with blank enter
            // Confirm once finished

        // 2C: DISPLAY
            // Console.log user details
    }
}

(() => {
    // Boot
    employees.push(new Manager("John A", 22, 40));
    employees.push(new Employee("Mark D", 16, 40));
    employees.push(new PartTime("Alissa E", 18, 20));
    input.addEventListener('keydown', Main.handleSubKeydown);
})();

export {
    Main,
    employees
}