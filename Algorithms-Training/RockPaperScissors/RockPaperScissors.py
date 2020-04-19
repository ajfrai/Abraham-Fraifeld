#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Created on Sat Nov 30 10:58:41 2019

@author: fraifeld-mba
"""


import getpass
def game(a,b):
    win_dict = {"paper":"rock","scissors":"paper","rock":"scissors"}
    if(win_dict[a]==b):
        print("Player 1 wins with " + a+"\n")
        return 1
    if (win_dict[b]==a):
        print("Player 2 wins with " + b+"\n")
        return 2
    else:
        print("Tie")
        return 0
 
def validate(answer):
    if answer.lower() not in ["rock","paper","scissors"]:
        return False
    return True

def solicit_choice(player):
    game_string = player + " select rock, paper, or scissors: "
    a = (getpass.getpass(game_string)).lower()
    while (not(validate(a))):
        print("Your choice is invalid. Please select again.")
        a = (getpass.getpass(game_string)).lower()
    return a
    
def solicit_choices():  
    return [solicit_choice("Player 1"),solicit_choice("Player 2")]

def change_scoreboard(result,scoreboard,limit):
    if result == 1:
        scoreboard[0] = scoreboard[0]+1
    if result == 2:
        scoreboard[1] = scoreboard[1]+1
    
    if (max(scoreboard)==limit):
        winner = [i for i,x in enumerate(scoreboard) if x ==max(scoreboard)][0]+1
        scoreboard = [winner,"limit"]
    return scoreboard
    
game_exit = 0
scoreboard=[0,0]
limit = input("What would you like to play until: ")
while(not(limit.isnumeric())):
    print("That is not a number. The score limit must be a number.")
    limit = input("What is the score limit: ")


limit = int(limit)
while(not(game_exit)):
    choices = solicit_choices()
    scoreboard = change_scoreboard(game(choices[0],choices[1]),scoreboard,limit)
    if(scoreboard[1]=="limit"):
        print("The winner is Player " + str(scoreboard[0]) + "!")
        game_exit = 1