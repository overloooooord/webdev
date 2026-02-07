let schedule = {};

function isEmpty(schedule) {
    for(let key in schedule){
        return false;
    }
    return true;
}

alert(isEmpty(schedule));

schedule["8:30"] = "go to school";

alert(isEmpty(schedule));