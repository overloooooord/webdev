function multiplyNumeric(menu) {
    for(let key in menu){
        if(typeof menu[key] == 'number') menu[key] *= 2;
    }
}